import type { MeasureOptions, PageMeasurement } from "../../application/audit-contract";

/**
 * Measures responsive accessibility problems in the current document at its current viewport.
 *
 * It runs inside the audited page and is serialized with Function.prototype.toString, so it must stay
 * self-contained: no imports, no module-level values, no helpers declared outside this function.
 */
export function measurePage(options: MeasureOptions): PageMeasurement {
  type Rect = { x: number; y: number; width: number; height: number };

  type Element_ = PageMeasurement["issues"][number]["element"];

  type Issue = PageMeasurement["issues"][number];

  const doc = document.documentElement;
  const body = document.body;
  const viewportWidth = doc.clientWidth || innerWidth;
  const viewportHeight = innerHeight;
  const scrolling = document.scrollingElement ?? doc;
  const clipValues = ["hidden", "clip"];
  const htmlStyle = getComputedStyle(doc);
  const bodyStyle = body ? getComputedStyle(body) : htmlStyle;
  const pageClipsX = clipValues.includes(htmlStyle.overflowX) || clipValues.includes(bodyStyle.overflowX);
  const scrollWidth = Math.max(scrolling.scrollWidth, body?.scrollWidth ?? 0);
  const pageOverflowPx = pageClipsX ? 0 : Math.max(0, scrollWidth - viewportWidth);
  const issues: Issue[] = [];
  const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + "…";
  const round = (value: number) => Math.round(value * 10) / 10;

  const meta = document.querySelector('meta[name="viewport" i]');
  const metaContent = clip(meta?.getAttribute("content") ?? "", 512);
  const metaPairs = new Map(metaContent.split(/[,;]/).map((pair) => pair.split("=").map((part) => part.trim().toLowerCase())).filter((pair) => pair[0]).map((pair) => [pair[0], pair[1] ?? ""]));
  const maximumScale = Number(metaPairs.get("maximum-scale"));
  const zoomBlocked = ["no", "0"].includes(metaPairs.get("user-scalable") ?? "") || (Number.isFinite(maximumScale) && metaPairs.has("maximum-scale") && maximumScale < 2);

  const docRect = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();

    return { x: round(rect.x + scrollX), y: round(rect.y + scrollY), width: round(rect.width), height: round(rect.height) };
  };

  const ownText = (element: Element) => {
    let value = "";

    for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) value += node.nodeValue ?? "";

    return value.replace(/\s+/g, " ").trim();
  };

  const sensitive = "input,textarea,select,[contenteditable]";

  const labelOf = (element: Element) => {
    const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("alt");

    if (aria) return clip(aria.trim(), 160);

    if (element.matches(sensitive)) return `[${element.tagName.toLowerCase()}]`;
    const value = (element.textContent ?? "").replace(/\s+/g, " ").trim();

    return clip(value || element.tagName.toLowerCase(), 160);
  };

  const selectorOf = (element: Element) => {
    const testId = element.getAttribute("data-testid");

    if (testId && testId.length <= 200) return `[data-testid=${JSON.stringify(testId)}]`;
    const parts: string[] = [];
    let current: Element | null = element;

    while (current && current !== doc && parts.length < 5) {
      if (current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) { parts.unshift(`#${current.id}`); break; }

      let part = current.tagName.toLowerCase();
      const classes = [...current.classList].filter((name) => /^[A-Za-z_][\w-]{0,40}$/.test(name) && !/^(?:css|sc|jsx|svelte|astro)-/.test(name)).slice(0, 2);

      if (classes.length) part += classes.map((name) => `.${name}`).join("");
      const parent: Element | null = current.parentElement;

      if (parent) {
        const peers = [...parent.children].filter((peer) => peer.tagName === current!.tagName);

        if (peers.length > 1 && !classes.length) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
      }

      parts.unshift(part);

      if (current === body) break;
      current = parent;
    }

    return clip(parts.join(" > "), 1_024);
  };

  /**
   * React development builds keep the JSX call stack and the owner (the component that wrote the JSX) on each fiber; use them
   * as an unverified source hint. Server Component owners (Next.js App Router) are plain objects with a name and a stack.
   */
  const sourceOf = (element: Element): Element_["source"] => {
    interface Named { name?: string; displayName?: string }

    interface DebugNode { type?: (Named & { render?: Named }) | string | null; name?: unknown; _debugStack?: { stack?: string }; debugStack?: { stack?: string }; _debugOwner?: DebugNode | null; owner?: DebugNode | null }

    const fileOf = (stack: string) => {
      for (const frame of stack.split("\n").slice(1, 12)) {
        // Server Component frames are replayed as about://React/Server/<url>, and webpack URLs contain "(layer)" parentheses.
        const match = /((?:(?:about|rsc):\/\/React\/[\w-]+\/)?(?:https?|file|webpack-internal):\/\/\/?.+?|\[project\].+?):(\d+):\d+\)?\s*$/.exec(frame);

        if (!match) continue;
        let path = match[1].replace(/^(?:about|rsc):\/\/React\/[\w-]+\//, "");

        // Bundled chunks (Next's _next/static and .next/server, Turbopack's hashed chunk names) do not name a project file.
        if (/node_modules|react[-_]dom|react_jsx|jsx-dev-runtime|\/@vite\/|\/\.vite\/|next\/dist|\/_next\/|\/\.next\//.test(path)) continue;
        path = path.replace(/^\[project\]\//, "").replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?\.?\/?/, "").replace(/^file:\/\//, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\?.*$/, "");

        // Dev-server stack lines refer to transformed code, so only the file is kept as a hint.
        if (/\.(?:[jt]sx?|mdx?)$/.test(path)) return clip(decodeURIComponent(path), 1_024);
      }

      return null;
    };

    const nameOf = (owner: DebugNode | null | undefined) => {
      if (!owner) return null;
      const type: Named | undefined = owner.type instanceof Function ? owner.type : owner.type instanceof Object ? owner.type.render : undefined;

      return clip(String(type?.displayName || type?.name || owner.name || ""), 256) || null;
    };

    let node: DebugNode | null | undefined = Object.entries(element).find(([name]) => name.startsWith("__reactFiber$"))?.[1];

    if (!node) return null;
    let component: string | null = null;

    // Follow owners: each node's stack is its JSX call site inside its owner, so file and component stay paired.
    for (let depth = 0; node && depth < 30; depth++) {
      const owner: DebugNode | null | undefined = node._debugOwner ?? node.owner;
      const name = nameOf(owner);
      component ??= name;
      const file = fileOf(String(node._debugStack?.stack ?? node.debugStack?.stack ?? ""));

      if (file) return { component: name ?? component, file, line: null };
      node = owner;
    }

    return component ? { component, file: null, line: null } : null;
  };

  const describe = (element: Element, withSource = true): Element_ => ({
    selector: selectorOf(element),
    tag: element.tagName.toLowerCase().slice(0, 64),
    label: labelOf(element),
    testId: element.getAttribute("data-testid")?.slice(0, 512) ?? null,
    source: withSource ? sourceOf(element) : null,
    rect: docRect(element),
  });

  const push = (issue: Issue) => { if (issues.length < 160) issues.push(issue); };

  const viewportMeta = { present: !!meta, content: metaContent, deviceWidth: metaPairs.get("width") === "device-width", zoomBlocked };

  // Walk the rendered tree once, tracking whether an ancestor clips or scrolls horizontally.
  interface Entry { element: Element; style: CSSStyleDeclaration; rect: DOMRect; contained: boolean; fixed: boolean; parent: Entry | null; extends: boolean }

  const entries: Entry[] = [];
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const stack: Array<{ element: Element; contained: boolean; fixed: boolean; parent: Entry | null }> = body ? [{ element: body, contained: false, fixed: false, parent: null }] : [];
  let visited = 0;
  let truncated = false;

  while (stack.length) {
    const item = stack.pop()!;

    if (++visited > options.maxElements) { truncated = true; break; }

    if (skipTags.has(item.element.tagName) || item.element.closest("[data-mauxi-overlay]")) continue;
    const style = getComputedStyle(item.element);

    if (style.display === "none") continue;
    const rect = item.element.getBoundingClientRect();
    const fixed = item.fixed || style.position === "fixed";
    const extendsRight = !item.contained && !fixed && rect.width > 1 && rect.right > viewportWidth + .5;
    const entry: Entry = { element: item.element, style, rect, contained: item.contained, fixed, parent: item.parent, extends: extendsRight };
    entries.push(entry);
    // html/body clipping is reported as pageClipsX rather than treated as a containing scroller.
    const clipsChildren = item.element !== body && (style.overflowX !== "visible" || style.contain.includes("paint") || style.contain === "strict" || style.contain === "content");
    const children = [...item.element.children];

    for (let index = children.length - 1; index >= 0; index--) stack.push({ element: children[index], contained: item.contained || clipsChildren, fixed, parent: entry });
  }

  const invisible = (entry: Entry) => entry.style.visibility === "hidden" || entry.style.opacity === "0" || (entry.rect.width <= 1 && entry.rect.height <= 1) || (entry.style.clip !== "auto" && entry.style.clip !== "") || entry.style.clipPath === "inset(50%)";
  const meaningful = (element: Element) => !!(element.textContent ?? "").trim() || element.matches("img,svg,video,canvas,picture,iframe,input,select,textarea,button,a[href],table");
  const reported = new Set<Element>();

  // 1. Horizontal page overflow and content cut off by html/body overflow-x: hidden.
  if (pageOverflowPx > 0 || pageClipsX) {
    // A child reaching further than its overflowing parent is its own cause (e.g. a fixed-width row inside a body that only overflows by the scrollbar).
    const offenders = entries.filter((entry) => entry.extends && !invisible(entry) && !(entry.parent?.extends && entry.parent.rect.right >= entry.rect.right - .5));
    const byParent = new Map<Element | null, Entry[]>();

    for (const entry of offenders) byParent.set(entry.parent?.element ?? null, [...(byParent.get(entry.parent?.element ?? null) ?? []), entry]);

    for (const [parent, group] of byParent) {
      const parentEntry = group[0].parent;

      // Grid or flex tracks wider than a container that itself fits: the container's track sizing is the cause.
      if (parent && parent !== body && parentEntry && /grid|flex/.test(parentEntry.style.display) && parent.scrollWidth > parent.clientWidth + 1) {
        if (pageClipsX && !meaningful(parent)) continue;
        reported.add(parent);
        push({ kind: pageClipsX ? "clipped-by-page" : "page-overflow", element: describe(parent), overflowPx: round(Math.max(...group.map((entry) => entry.rect.right - viewportWidth))), detail: `Its ${parentEntry.style.display.includes("grid") ? "grid" : "flex"} tracks are ${round(parent.scrollWidth)}px wide inside a ${round(parentEntry.rect.width)}px container; ${group.length > 1 ? `${group.length} children extend` : "a child extends"} past the viewport.` });
        continue;
      }

      const hidden = group.every((entry) => entry.element.closest('[aria-hidden="true"],[inert]') || entry.rect.left >= viewportWidth);

      if (pageClipsX && hidden) continue;

      if (pageClipsX && !group.some((entry) => meaningful(entry.element))) continue;
      const kind = pageClipsX ? "clipped-by-page" : "page-overflow";

      if (group.length > 1 && parent && parent !== body) {
        const overflow = Math.max(...group.map((entry) => entry.rect.right - viewportWidth));
        reported.add(parent);
        push({ kind, element: describe(parent), overflowPx: round(overflow), detail: `${group.length} children extend past the viewport; the container does not wrap or shrink them.` });
      } else for (const entry of group.slice(0, 6)) {
        reported.add(entry.element);
        const scrollbarOnly = innerWidth > viewportWidth && Math.abs(entry.rect.right - innerWidth) < 1;
        push({ kind, element: describe(entry.element), overflowPx: round(entry.rect.right - viewportWidth), detail: scrollbarOnly
          ? `Box spans the full window including the vertical scrollbar (100vw or a min-width equal to the viewport), so it overflows by the scrollbar's ${round(innerWidth - viewportWidth)}px.`
          : `Box is ${round(entry.rect.width)}px wide and ends ${round(entry.rect.right - viewportWidth)}px past the viewport.` });
      }
    }

    // Content wider than its own box (long words, wide inline media) inside boxes that fit.
    for (const entry of entries) {
      if (reported.size >= 20) break;

      if (entry.extends || entry.contained || entry.fixed || invisible(entry) || entry.style.overflowX !== "visible") continue;
      const element = entry.element;
      const contentRight = entry.rect.left + element.scrollWidth;

      if (element.scrollWidth <= element.clientWidth + 1 || contentRight <= viewportWidth + .5 || !ownText(element)) continue;

      if ([...element.children].some((child) => reported.has(child))) continue;
      reported.add(element);
      const longest = ownText(element).split(" ").reduce((best, word) => word.length > best.length ? word : best, "");
      push({ kind: pageClipsX ? "clipped-by-page" : "page-overflow", element: describe(element), overflowPx: round(contentRight - viewportWidth), detail: clip(`Text overflows its box${longest.length > 18 ? `; unbreakable string "${longest}"` : ""}.`, 512) });
    }

    if (!reported.size && pageOverflowPx > 0) push({ kind: "page-overflow", element: describe(doc, false), overflowPx: round(pageOverflowPx), detail: "The document scrolls horizontally but no single offending element was isolated." });
  }

  // 2. Containers that scroll or clip horizontally: classify deliberate scrollers vs. accidental ones.
  const scrollerNames = /carousel|slider|slides?\b|swiper|embla|splide|slick|keen|glide|flickity|marquee|scroller|scroll-x|gallery|track|rail|ticker|tabs?\b|tablist|chips|logos/i;
  const controlNames = /prev|next|previous|anterior|siguiente|scroll (?:left|right)|^[‹›←→<>]$/i;
  const focusable = "a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex='-1']),summary,[contenteditable]:not([contenteditable=false])";

  for (const entry of entries) {
    const element = entry.element;

    if (element === body || entry.style.overflowX === "visible" || invisible(entry)) continue;

    if (element.scrollWidth <= element.clientWidth + 1 || element.clientWidth < 40) continue;
    const signals: string[] = [];
    const snap = entry.style.scrollSnapType;

    if (snap && snap !== "none" && /x|both|inline/.test(snap)) signals.push("scroll-snap");
    const role = element.getAttribute("role");
    const roleDescription = element.getAttribute("aria-roledescription") ?? "";

    if (/carousel|slide/i.test(roleDescription)) signals.push("aria-roledescription");

    if (role && ["region", "list", "tablist", "listbox", "marquee", "toolbar", "group"].includes(role)) signals.push(`role=${role}`);
    const names = `${element.getAttribute("class") ?? ""} ${element.id} ${[...element.attributes].flatMap((attribute) => attribute.name.startsWith("data-") ? [attribute.name] : []).join(" ")}`;

    if (scrollerNames.test(names)) signals.push("named-scroller");

    if (element.matches("pre,code") || element.querySelector(":scope > pre, :scope > code")) signals.push("code-block");

    if (element.matches("table") || element.querySelector(":scope > table, :scope > * > table")) signals.push("data-table");
    const items = [...element.children].filter((child) => child.getBoundingClientRect().width > 0);

    if (items.length >= 3) {
      const widths = items.map((child) => child.getBoundingClientRect().width);
      const mean = widths.reduce((sum, width) => sum + width, 0) / widths.length;
      const deviation = Math.sqrt(widths.reduce((sum, width) => sum + (width - mean) ** 2, 0) / widths.length);

      if (mean > 0 && deviation / mean < .2) signals.push("uniform-items");
    }

    const scope = element.parentElement;

    if (scope && [...scope.querySelectorAll("button,[role=button]")].some((button) => !element.contains(button) && controlNames.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))) signals.push("prev-next-controls");
    const scrollable = ["auto", "scroll"].includes(entry.style.overflowX);
    const strong = signals.filter((signal) => signal !== "uniform-items" && !signal.startsWith("role=list") && signal !== "role=group");
    const intentional = strong.length > 0 || (scrollable && signals.includes("uniform-items"));
    const keyboard = (element instanceof HTMLElement && element.tabIndex >= 0) || !!element.querySelector(focusable);
    const named = !!(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.getAttribute("title"));

    if (scrollable) push({ kind: "scroller", element: describe(element), overflowPx: round(element.scrollWidth - element.clientWidth), scroller: { overflowX: entry.style.overflowX, intentional, signals, keyboard, named, role }, detail: `Scrolls ${round(element.scrollWidth - element.clientWidth)}px horizontally.` });
    else if (!intentional && (ownText(element) || items.some((child) => child.getBoundingClientRect().right > entry.rect.right + 1 && meaningful(child)))) push({ kind: "hidden-overflow", element: describe(element), overflowPx: round(element.scrollWidth - element.clientWidth), scroller: { overflowX: entry.style.overflowX, intentional, signals, keyboard, named, role }, detail: `overflow-x: ${entry.style.overflowX} hides ${round(element.scrollWidth - element.clientWidth)}px of content.` });
  }

  if (options.full) {
    // 3. Text that no longer fits its box (fixed heights, nowrap, ellipsis, line clamps).
    let clipped = 0;

    for (const entry of entries) {
      if (clipped >= 30) break;
      const element = entry.element;
      const content = (element.textContent ?? "").trim();

      if (invisible(entry) || !content || content.length > 600 || element.matches(sensitive)) continue;
      const style = entry.style;
      const clipsX = style.overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1;
      const clipsY = style.overflowY !== "visible" && element.scrollHeight > element.clientHeight + 2;

      if (!clipsX && !clipsY) continue;

      if (["auto", "scroll"].includes(style.overflowX) || ["auto", "scroll"].includes(style.overflowY)) continue;
      clipped++;
      const ellipsis = style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "");
      push({ kind: "text-clipped", element: describe(element), ellipsis, overflowPx: round(Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight)), detail: `Text is cut off ${clipsX && clipsY ? "horizontally and vertically" : clipsX ? "horizontally" : "vertically"}${ellipsis ? " (truncated on purpose)" : ""}.` });
    }

    // 4. Target size minimum (WCAG 2.5.8): 24×24 CSS px, or enough spacing around smaller targets.
    const interactive = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[tabindex]:not([tabindex='-1'])";
    const targets = entries.filter((entry) => entry.element.matches(interactive) && !invisible(entry) && !entry.element.matches(":disabled") && entry.rect.width > 0 && entry.rect.height > 0 && entry.rect.bottom > 0 && entry.rect.top < Math.max(viewportHeight, entry.rect.top + 1) && entry.rect.right > 0 && entry.rect.left < viewportWidth);
    const centers = targets.map((entry) => ({ entry, x: entry.rect.left + entry.rect.width / 2, y: entry.rect.top + entry.rect.height / 2 }));
    let small = 0;

    for (const target of centers) {
      if (small >= 40) break;
      const { entry } = target;

      if (entry.rect.width >= 24 && entry.rect.height >= 24) continue;
      const element = entry.element;

      if (element.matches("a") && entry.style.display.startsWith("inline") && (element.parentElement?.textContent ?? "").trim().length > (element.textContent ?? "").trim().length + 12) continue;

      if (element.matches("input[type=checkbox],input[type=radio]") && element instanceof HTMLInputElement && (element.labels?.length ?? 0) > 0) continue;

      const crowded = centers.some((other) => {
        if (other === target || other.entry.element.contains(element) || element.contains(other.entry.element)) return false;
        const dx = Math.max(other.entry.rect.left - target.x, 0, target.x - other.entry.rect.right);
        const dy = Math.max(other.entry.rect.top - target.y, 0, target.y - other.entry.rect.bottom);
        const otherSmall = other.entry.rect.width < 24 || other.entry.rect.height < 24;

        return Math.hypot(dx, dy) < 12 || (otherSmall && Math.hypot(other.x - target.x, other.y - target.y) < 24);
      });

      if (!crowded) continue;
      small++;
      push({ kind: "target-size", element: describe(element), detail: `Target is ${round(entry.rect.width)}×${round(entry.rect.height)}px and sits within 24px of another target.` });
    }

    // 5. Fixed or sticky bars that cover a large share of a short viewport (WCAG 2.4.11 risk).
    const onScreen = (rect: DOMRect) => rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;

    const bars = entries.filter((entry) => ["fixed", "sticky"].includes(entry.style.position) && !invisible(entry) && !entry.element.closest('[aria-hidden="true"],[inert]') && onScreen(entry.rect)
      && Math.min(entry.rect.right, viewportWidth) - Math.max(entry.rect.left, 0) >= viewportWidth * .5 && entry.rect.height < viewportHeight * .9 && !(entry.parent && ["fixed", "sticky"].includes(entry.parent.style.position)));

    const top = bars.filter((entry) => entry.rect.top <= 2);
    const bottom = bars.filter((entry) => entry.rect.bottom >= viewportHeight - 2 && entry.rect.top > 2);
    const covered = Math.min(viewportHeight, top.reduce((sum, entry) => Math.max(sum, entry.rect.bottom), 0) + bottom.reduce((sum, entry) => Math.max(sum, viewportHeight - entry.rect.top), 0));
    const coverage = covered / viewportHeight;

    if (coverage > .4 && bars.length) {
      const largest = [...top, ...bottom].sort((a, b) => b.rect.height - a.rect.height)[0];
      push({ kind: "sticky-obstruction", element: describe(largest.element), coverage: round(coverage * 100), detail: `Fixed/sticky bars cover ${Math.round(coverage * 100)}% of a ${viewportWidth}×${viewportHeight} viewport (${[...top, ...bottom].map((entry) => selectorOf(entry.element)).slice(0, 3).join(", ")}).` });
    }
  }

  return { url: clip(location.href, 4_096), viewport: { width: viewportWidth, height: viewportHeight }, documentHeight: Math.max(scrolling.scrollHeight, body?.scrollHeight ?? 0), pageOverflowPx: round(pageOverflowPx), pageClipsX, viewportMeta, issues, visited, truncated };
}
