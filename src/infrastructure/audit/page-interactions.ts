import type { InteractionIssue, InteractionRequest, InteractionResult } from "../../application/audit-interactions";

/**
 * One step of the interaction pass, run inside the audited page between host-dispatched Tab presses, clicks and hovers.
 * State between steps lives on a non-enumerable window symbol and is removed by "cleanup".
 *
 * Serialized with Function.prototype.toString like measurePage, so it must stay self-contained. The element description
 * helpers mirror measurePage's so findings from both group under the same selectors.
 */
export function interactionStep(request: InteractionRequest): InteractionResult {
  type Element_ = InteractionIssue["element"];

  type Rect = InteractionIssue["view"];

  type Point = { x: number; y: number };

  /** stateless: the trigger shows no aria-expanded before or after opening, so only witness (what it revealed) tells whether it closed. */
  interface Initial { url: string; expanded: string; scrollX: number; scrollY: number; scrollWidth: number; content: Element | null; shown: boolean; popups: Set<Element>; stateless: boolean; witness: Element | null }

  interface State { baseline: WeakMap<Element, Map<string, string>>; visited: Set<Element>; stops: number; sentinel: HTMLElement | null; triggers: Element[]; tooltips: Array<{ trigger: Element; tip: Element }>; initial: Map<number, Initial> }

  const KEY = Symbol.for("mauxi.audit.interactions");
  const doc = document.documentElement;
  const body = document.body;
  const viewportWidth = doc.clientWidth || innerWidth;
  const viewportHeight = innerHeight;
  const stored: State | undefined = Object.getOwnPropertyDescriptor(window, KEY)?.value;
  const state: State = stored ?? { baseline: new WeakMap(), visited: new Set(), stops: 0, sentinel: null, triggers: [], tooltips: [], initial: new Map() };

  if (!stored) Object.defineProperty(window, KEY, { value: state, configurable: true, enumerable: false, writable: false });
  const clip = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + "…";
  const round = (value: number) => Math.round(value * 10) / 10;

  const labelOf = (element: Element) => {
    const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.getAttribute("alt");

    if (aria) return clip(aria.trim(), 160);

    if (element.matches("input,textarea,select,[contenteditable]")) return `[${element.tagName.toLowerCase()}]`;
    const value = (element.textContent ?? "").replace(/\s+/g, " ").trim();

    return clip(value || element.tagName.toLowerCase(), 160);
  };

  /** A readable selector that resolves to this element first: same-class siblings get :nth-of-type, and longer paths are tried when the short one is ambiguous. */
  const selectorOf = (element: Element) => {
    const resolves = (selector: string) => { try { return selector.length <= 1_024 && document.querySelector(selector) === element; } catch { return false; } };
    const testId = element.getAttribute("data-testid");
    const byTestId = testId && testId.length <= 200 ? `[data-testid=${JSON.stringify(testId)}]` : "";

    if (byTestId && resolves(byTestId)) return byTestId;
    // readable stops at the nearest usable id; exact numbers every step up to body.
    const readable: string[] = [];
    const exact: string[] = [];
    let anchored = false;

    for (let current: Element | null = element; current && current !== doc; current = current.parentElement) {
      if (!anchored && current.id && /^[A-Za-z][\w-]{0,80}$/.test(current.id)) { readable.unshift(`#${current.id}`); anchored = true; }

      const tag = current.tagName.toLowerCase();
      const classes = [...current.classList].filter((name) => /^[A-Za-z_][\w-]{0,40}$/.test(name) && !/^(?:css|sc|jsx|svelte|astro)-/.test(name)).slice(0, 2);
      const peers = current.parentElement ? [...current.parentElement.children].filter((peer) => peer.tagName === current!.tagName) : [];
      const nth = peers.length > 1 ? `:nth-of-type(${peers.indexOf(current) + 1})` : "";
      const twins = !classes.length || peers.some((peer) => peer !== current && classes.every((name) => peer.classList.contains(name)));

      if (!anchored) readable.unshift(tag + classes.map((name) => `.${name}`).join("") + (twins ? nth : ""));
      exact.unshift(tag + nth);

      if (current === body) break;
    }

    for (const candidate of [readable.slice(-5).join(" > "), readable.join(" > "), exact.join(" > ")]) if (resolves(candidate)) return candidate;

    return clip(byTestId || readable.slice(-5).join(" > "), 1_024);
  };

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

  const viewRect = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();

    return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
  };

  const describe = (element: Element): Element_ => {
    const rect = viewRect(element);

    return { selector: selectorOf(element), tag: element.tagName.toLowerCase().slice(0, 64), label: labelOf(element), testId: element.getAttribute("data-testid")?.slice(0, 512) ?? null, source: sourceOf(element), rect: { ...rect, x: round(rect.x + scrollX), y: round(rect.y + scrollY) } };
  };

  const parentOf = (node: Element): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();

    return root instanceof ShadowRoot ? root.host : null;
  };

  /** Whether node is ancestor itself or inside it, crossing open shadow roots. */
  const within = (node: Element, ancestor: Element) => {
    for (let current: Element | null = node; current; current = parentOf(current)) if (current === ancestor) return true;

    return false;
  };

  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.opacity !== "0" && style.display !== "none";
  };

  const deepActive = () => {
    let active = document.activeElement;

    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

    return active;
  };

  const hitPoint = (element: Element): Point | null => {
    const rect = element.getBoundingClientRect();

    for (const [fx, fy] of [[.5, .5], [.25, .5], [.75, .5], [.5, .25], [.5, .75]]) {
      const x = rect.left + rect.width * fx;
      const y = rect.top + rect.height * fy;

      if (x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) continue;
      const hit = document.elementFromPoint(x, y);

      if (hit && within(hit, element)) return { x: round(x), y: round(y) };
    }

    return null;
  };

  /** Scrolls the element to the center, or else to the first position where a fixed bar does not cover it. */
  const reveal = (element: Element): Point | null => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const centered = hitPoint(element);

    if (centered) return centered;

    for (let top = 0; top + 8 <= viewportHeight; top += 8) {
      scrollBy(0, element.getBoundingClientRect().top - top);
      const point = hitPoint(element);

      if (point) return point;
    }

    element.scrollIntoView({ block: "center", inline: "nearest" });

    return null;
  };

  const coverOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);
    const hit = document.elementFromPoint(x, y);

    return hit ? selectorOf(hit) : "nothing";
  };

  // Focus indicator comparison: strong properties draw a ring, box or fill; weak ones only recolor or restyle text.
  const STRONG = ["outline-style", "outline-width", "outline-color", "box-shadow", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-width", "border-bottom-width", "border-top-style", "border-bottom-style", "background-color", "background-image"];
  const WEAK = ["color", "text-decoration-line", "text-decoration-color", "text-decoration-thickness", "font-weight", "opacity", "transform", "filter", "text-shadow"];
  const PSEUDO = ["content", "outline-style", "box-shadow", "border-bottom-color", "border-bottom-width", "background-color", "opacity", "transform", "width", "height"];

  const read = (element: Element, pseudo: string | null, properties: string[]) => {
    const style = getComputedStyle(element, pseudo);

    return new Map(properties.map((property) => [`${pseudo ?? ""}${property}`, style.getPropertyValue(property)]));
  };

  const signature = (element: Element, self: boolean) => new Map([...read(element, null, self ? [...STRONG, ...WEAK] : STRONG), ...(self ? [...read(element, "::before", PSEUDO), ...read(element, "::after", PSEUDO)] : [])]);
  const outlineShown = (values: Map<string, string>) => values.get("outline-style") !== "none" && parseFloat(values.get("outline-width") ?? "0") > 0;

  const alpha = (color: string) => {
    if (color === "transparent") return 0;
    const parts = /rgba?\(([^)]*)\)/.exec(color)?.[1].split(/[\s,/]+/).filter(Boolean) ?? [];

    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  };

  /** Whether a hit inside a fixed bar lands on something that paints (not a transparent wrapper). */
  const paints = (hit: Element, bar: Element) => {
    for (let current: Element | null = hit; current; current = parentOf(current)) {
      const style = getComputedStyle(current);

      if (alpha(style.backgroundColor) > 0 || style.backgroundImage !== "none" || parseFloat(style.borderTopWidth) > 0 || current.matches("img,svg,video,canvas,picture,iframe,input,button")) return true;

      if ([...current.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim())) return true;

      if (current === bar) return false;
    }

    return false;
  };

  const outerBar = (hit: Element) => {
    let bar: Element | null = null;

    for (let current: Element | null = hit; current && current !== body && current !== doc; current = parentOf(current)) if (["fixed", "sticky"].includes(getComputedStyle(current).position)) bar = current;

    return bar;
  };

  const measureFocus = (active: Element, stop: number): InteractionIssue[] => {
    const issues: InteractionIssue[] = [];
    const rect = active.getBoundingClientRect();
    const style = getComputedStyle(active);
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, viewportWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, viewportHeight);
    const name = `${active.tagName.toLowerCase()} "${labelOf(active)}"`;
    const hiddenStyle = !active.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || (rect.width <= 1 && rect.height <= 1) || style.clipPath === "inset(50%)" || (style.clip !== "auto" && style.clip !== "");

    if (right - left < 1 || bottom - top < 1 || hiddenStyle) {
      issues.push({ kind: "focus-not-visible", variant: "offscreen", element: describe(active), view: viewRect(active), detail: clip(`Focus stop ${stop} moved to ${name}, which is ${hiddenStyle ? "visually hidden" : `outside the ${viewportWidth}×${viewportHeight} viewport (at ${round(rect.left)}, ${round(rect.top)})`} while focused, so keyboard users cannot see where they are.`, 512) });

      return issues;
    }

    // 2.4.11: hit-test a grid over the visible part of the focused element.
    const columns = 5;
    const rows = 3;
    let total = 0;
    const covering = new Map<Element, number>();

    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        const x = left + (right - left) * (column + .5) / columns;
        const y = top + (bottom - top) * (row + .5) / rows;
        total++;
        const hit = document.elementFromPoint(x, y);

        if (!hit || within(hit, active) || within(active, hit)) continue;
        const bar = outerBar(hit);

        if (bar && !within(active, bar) && paints(hit, bar)) covering.set(bar, (covering.get(bar) ?? 0) + 1);
      }
    }

    const coveredPoints = [...covering.values()].reduce((sum, count) => sum + count, 0);

    if (coveredPoints > 0) {
      const bar = [...covering.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const full = coveredPoints >= total;
      issues.push({ kind: "focus-obscured", variant: full ? "full" : "partial", element: describe(active), cause: describe(bar), view: viewRect(active), detail: clip(`At focus stop ${stop}, ${name} is ${full ? "entirely" : `${Math.round(coveredPoints / total * 100)}%`} hidden behind ${selectorOf(bar)} at ${viewportWidth}×${viewportHeight}.`, 512) });
    }

    // 2.4.7: compare with the style captured before anything had focus.
    const before = state.baseline.get(active);

    if (before) {
      const now = signature(active, true);
      const changed = [...now.keys()].filter((key) => now.get(key) !== before.get(key));
      const strongSelf = changed.some((key) => STRONG.includes(key) && (!key.startsWith("outline") || outlineShown(now)));
      const strongPseudo = changed.some((key) => key.startsWith("::"));
      let strongAncestor = false;
      let ancestor = parentOf(active);

      for (let depth = 0; ancestor && ancestor !== body && depth < 3 && !strongAncestor; depth++, ancestor = parentOf(ancestor)) {
        const base = state.baseline.get(ancestor);

        if (!base) continue;
        const current = signature(ancestor, false);
        strongAncestor = [...current.keys()].some((key) => current.get(key) !== base.get(key) && (!key.startsWith("outline") || outlineShown(current)));
      }

      if (!strongSelf && !strongPseudo && !strongAncestor) {
        const weak = changed.filter((key) => WEAK.includes(key));
        issues.push({ kind: "focus-not-visible", variant: weak.length ? "subtle" : "none", element: describe(active), view: viewRect(active), detail: clip(weak.length
          ? `When ${name} receives keyboard focus only ${weak.join(", ")} change${weak.length === 1 ? "s" : ""}; no outline, ring, border or background marks it.`
          : `When ${name} receives keyboard focus nothing about it changes: outline is ${now.get("outline-style")}, and no ring, border, background, text decoration or pseudo-element appears on it or its parents.`, 512) });
      }
    }

    return issues;
  };

  const expandedOf = (element: Element) => {
    if (element.tagName === "SUMMARY") return String(element.parentElement instanceof HTMLDetailsElement && element.parentElement.open);

    return String(element.getAttribute("aria-expanded"));
  };

  const contentOf = (trigger: Element): Element | null => {
    if (trigger.tagName === "SUMMARY") return trigger.parentElement;
    const ids = (trigger.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);

    for (const id of ids) {
      const target = document.getElementById(id);

      if (target) return target;
    }

    return trigger.nextElementSibling;
  };

  const POPUPS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tree"],[role="grid"],[aria-modal="true"],dialog[open],[popover]';
  const openPopups = () => new Set([...document.querySelectorAll(POPUPS)].slice(0, 200).filter((element) => !element.closest("[data-mauxi-overlay]") && visible(element)));

  const NAVIGATES = /\blocation\b|navigate|router|\bhref\b|submit|window\.open|history\.(?:push|replace)State|\.assign\(/i;
  const ACTION = /\b(?:delete|remove|buy|pay|purchase|checkout|sign ?out|log ?out|send|unsubscribe)\b/i;

  const skipReason = (element: Element) => {
    if (!(element instanceof HTMLButtonElement) && element.tagName !== "SUMMARY") return "not a button or summary; links and other elements are never activated";

    if (element instanceof HTMLButtonElement) {
      if (element.form && element.type === "submit") return "it submits a form";

      if (element.hasAttribute("formaction")) return "it has a formaction";

      if (element.closest("a[href]")) return "it is inside a link";
    }

    if (NAVIGATES.test(element.getAttribute("onclick") ?? "")) return "its inline click handler navigates";
    const props = Object.entries(element).find(([name]) => name.startsWith("__reactProps$"))?.[1];
    const handler: unknown = props?.onClick;

    if (handler instanceof Function && NAVIGATES.test(Function.prototype.toString.call(handler))) return "its click handler navigates";

    if (ACTION.test(labelOf(element))) return "its name reads like an action that changes data";

    return null;
  };

  /**
   * The box the opened content occupies. Each descendant is cut to the overflow boxes of the ancestors (up to and including
   * content) that clip it, so items inside an inner scroller count where that scroller is: scrolling it reaches them.
   */
  const unionOf = (content: Element, exclude: Element | null) => {
    type Box = { left: number; right: number; top: number; bottom: number };

    const union: Box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    const add = (rect: Box) => { union.left = Math.min(union.left, rect.left); union.right = Math.max(union.right, rect.right); union.top = Math.min(union.top, rect.top); union.bottom = Math.max(union.bottom, rect.bottom); };
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => styles.get(element) ?? styles.set(element, getComputedStyle(element)).get(element)!;
    // Fixed boxes escape every ancestor and absolute ones escape static ancestors, unless one of these makes it their containing block.
    const containsAll = (style: CSSStyleDeclaration) => style.transform !== "none" || style.filter !== "none" || style.perspective !== "none" || /paint|layout|strict|content/.test(style.contain);

    const clipped = (element: Element): Box | null => {
      const rect = element.getBoundingClientRect();
      const box: Box = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      let position = styleOf(element).position;

      for (let current = parentOf(element); current; current = current === content ? null : parentOf(current)) {
        const style = styleOf(current);

        if (position === "fixed" ? !containsAll(style) : position === "absolute" && style.position === "static" && !containsAll(style)) continue;
        position = style.position;

        if (/^(?:inline|contents)$/.test(style.display)) continue;
        const paint = /paint|strict|content/.test(style.contain);
        const edge = current.getBoundingClientRect();

        if (paint || style.overflowX !== "visible") { box.left = Math.max(box.left, edge.left); box.right = Math.min(box.right, edge.right); }

        if (paint || style.overflowY !== "visible") { box.top = Math.max(box.top, edge.top); box.bottom = Math.min(box.bottom, edge.bottom); }

        if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
      }

      return box;
    };

    add(content.getBoundingClientRect());
    let counted = 0;

    for (const element of content.querySelectorAll("*")) {
      if (++counted > 400) break;

      if (exclude && within(element, exclude)) continue;
      const rect = element.getBoundingClientRect();

      if (rect.width < 1 || rect.height < 1 || styleOf(element).visibility === "hidden") continue;
      const box = clipped(element);

      if (box) add(box);
    }

    return union;
  };

  const fixedAncestor = (element: Element) => {
    for (let current: Element | null = element; current && current !== body; current = parentOf(current)) if (getComputedStyle(current).position === "fixed") return current;

    return null;
  };

  const measureContent = (trigger: Element, content: Element, initial: Initial): InteractionIssue[] => {
    const summary = trigger.tagName === "SUMMARY" ? trigger : null;
    const union = unionOf(content, summary);
    const fixed = fixedAncestor(content);
    const scrolling = document.scrollingElement ?? doc;
    const htmlStyle = getComputedStyle(doc);
    const pageClips = ["hidden", "clip"].includes(htmlStyle.overflowX) || (!!body && ["hidden", "clip"].includes(getComputedStyle(body).overflowX));
    const growth = round(scrolling.scrollWidth - initial.scrollWidth);
    const horizontal = round(Math.max(union.right - viewportWidth, -union.left, 0));
    const name = `${content.tagName.toLowerCase()} "${clip(labelOf(content), 60)}"`;
    const details: string[] = [];
    let overflowPx = 0;
    let variant: "overflow" | "clipped" = "overflow";

    if (horizontal > 1) {
      overflowPx = horizontal;
      details.push(`Opened ${name} spans ${round(union.right - union.left)}px and ends ${union.right > viewportWidth ? `${round(union.right - viewportWidth)}px past the right edge` : `${round(-union.left)}px before the left edge`} of the ${viewportWidth}px viewport${fixed ? "; it is position: fixed, so the cut-off part cannot be scrolled into view" : pageClips ? "; the page hides horizontal overflow, so the cut-off part cannot be reached" : growth > 0 ? `; the page now scrolls ${growth}px horizontally` : ""}.`);
    }

    if (fixed && union.bottom > viewportHeight + 1) {
      // A scroller up to the fixed box brings its overflow into reach, but only within its scrollport: a scrollport that itself
      // runs below the viewport leaves that strip unreachable at every scroll position.
      let port = Infinity;
      let scroller: Element | null = null;

      for (let current: Element | null = content; current; current = current === fixed ? null : parentOf(current)) {
        if (!["auto", "scroll"].includes(getComputedStyle(current).overflowY) || current.scrollHeight <= current.clientHeight + 1) continue;
        const bottom = current.getBoundingClientRect().top + current.clientTop + current.clientHeight;

        if (bottom < port) { port = bottom; scroller = current; }
      }

      const below = round(Math.min(union.bottom, port) - viewportHeight);

      if (below > 1) {
        variant = horizontal > 1 ? variant : "clipped";
        overflowPx = Math.max(overflowPx, below);
        const subject = details.length ? "It" : `Opened ${name}`;
        details.push(scroller
          ? `${subject} is position: fixed and its scroll area ${selectorOf(scroller)} ends ${below}px below the ${viewportWidth}×${viewportHeight} viewport, so that strip cannot be scrolled into view.`
          : `${subject} is position: fixed and runs ${below}px below the ${viewportWidth}×${viewportHeight} viewport without its own scroll, so its last items cannot be reached.`);
      }
    }

    if (!fixed) {
      for (let current = parentOf(content); current && current !== body && current !== doc; current = parentOf(current)) {
        const style = getComputedStyle(current);
        const clipsX = ["hidden", "clip"].includes(style.overflowX);
        const clipsY = ["hidden", "clip"].includes(style.overflowY);

        if (!clipsX && !clipsY) continue;
        const box = current.getBoundingClientRect();
        const hidden = Math.max(clipsX ? Math.max(union.right - box.right, box.left - union.left) : 0, clipsY ? union.bottom - box.bottom : 0);

        if (hidden > 1) {
          variant = horizontal > 1 ? variant : "clipped";
          overflowPx = Math.max(overflowPx, round(hidden));
          details.push(`${round(hidden)}px of it is cut off by overflow: hidden on ${selectorOf(current)}.`);
          break;
        }
      }
    }

    if (!details.length) return [];

    return [{ kind: "disclosure-overflow", variant, element: describe(content), cause: describe(trigger), view: viewRect(content), overflowPx, detail: clip(details.join(" "), 512) }];
  };

  switch (request.action) {
    case "focus-start": {
      const active = deepActive();

      if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
      scrollTo(0, 0);
      state.visited = new Set();
      state.stops = 0;
      state.baseline = new WeakMap();
      const focusables = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[tabindex]:not([tabindex='-1']),[contenteditable]:not([contenteditable=false]),audio[controls],video[controls]")].slice(0, 600);

      for (const element of focusables) {
        state.baseline.set(element, signature(element, true));
        let ancestor = parentOf(element);

        for (let depth = 0; ancestor && ancestor !== body && depth < 3; depth++, ancestor = parentOf(ancestor)) if (!state.baseline.has(ancestor)) state.baseline.set(ancestor, signature(ancestor, false));
      }

      // Start every walk from the top of the document, whatever was focused before.
      state.sentinel?.remove();
      const sentinel = document.createElement("span");
      sentinel.tabIndex = -1;
      sentinel.dataset.mauxiOverlay = "true";
      sentinel.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
      body?.prepend(sentinel);
      sentinel.focus({ preventScroll: true });
      state.sentinel = sentinel;

      return { count: focusables.length };
    }

    case "focus-measure": {
      const active = deepActive();
      const sentinel = state.sentinel;
      state.sentinel = null;
      sentinel?.remove();

      if (!active || active === sentinel) return { done: true, reason: "keyboard focus did not move from the start of the page" };

      if (active === body || active === doc) return { done: true, reason: "focus left the page content" };

      if (state.visited.has(active)) return { done: true, reason: "focus returned to an element already visited" };
      state.visited.add(active);
      state.stops++;

      if (active.tagName === "IFRAME") return { done: true, reason: "focus entered an iframe", label: labelOf(active), count: state.stops };

      return { done: false, label: labelOf(active), count: state.stops, issues: measureFocus(active, state.stops) };
    }

    case "disclosure-list": {
      const skipped: string[] = [];
      state.triggers = [];
      const candidates = [...new Set(document.querySelectorAll('button[aria-expanded="false"][aria-controls],details:not([open]) > summary,button[aria-haspopup]:not([aria-haspopup="false"]):not([aria-expanded="true"]),a[aria-expanded="false"],a[aria-haspopup],[role="button"][aria-expanded="false"]'))].slice(0, 200);

      for (const element of candidates) {
        if (element.closest('[data-mauxi-overlay],[inert],[aria-hidden="true"]') || !visible(element) || element.matches(":disabled")) continue;
        const reason = skipReason(element);

        if (reason) { if (skipped.length < 10) skipped.push(clip(`${element.tagName.toLowerCase()} "${labelOf(element)}" (${selectorOf(element)}): ${reason}`, 512)); continue; }

        if (state.triggers.length < 6) state.triggers.push(element);
      }

      return { count: state.triggers.length, skipped };
    }

    case "disclosure-target": {
      const trigger = state.triggers[request.index];

      if (!trigger?.isConnected) return { point: null, reason: "the trigger left the page" };
      const scrolling = document.scrollingElement ?? doc;
      const content = contentOf(trigger);
      const expanded = expandedOf(trigger);
      state.initial.set(request.index, { url: location.href, expanded, scrollX, scrollY, scrollWidth: scrolling.scrollWidth, content, shown: !!content && visible(content), popups: openPopups(), stateless: expanded === "null", witness: null });
      const point = reveal(trigger);

      return { point, label: `${trigger.tagName.toLowerCase()} "${labelOf(trigger)}"`, reason: point ? "" : `it is covered by ${coverOf(trigger)}` };
    }

    case "disclosure-measure": {
      const trigger = state.triggers[request.index];
      const initial = state.initial.get(request.index);

      if (!trigger?.isConnected || !initial) return { opened: false, reason: "the trigger left the page" };

      if (location.href !== initial.url) return { opened: false, urlChanged: true, reason: "activating it changed the URL" };
      const content = contentOf(trigger);
      const changed = expandedOf(trigger) !== initial.expanded;
      initial.stateless &&= !changed;

      // Content that was already showing proves nothing opened; otherwise a newly shown popup elsewhere is what must close again.
      if (initial.stateless) initial.witness = content && visible(content) && !(content === initial.content && initial.shown) ? content : [...openPopups()].find((popup) => !initial.popups.has(popup) && !within(trigger, popup)) ?? null;

      if (!content || !visible(content)) return { opened: changed, reason: "it revealed no visible content", point: hitPoint(trigger) };

      return { opened: true, issues: measureContent(trigger, content, initial), point: hitPoint(trigger) };
    }

    case "disclosure-check":
    case "disclosure-force-close": {
      const trigger = state.triggers[request.index];
      const initial = state.initial.get(request.index);

      if (!trigger || !initial) return { restored: false, reason: "the trigger left the page" };

      if (request.action === "disclosure-force-close") {
        if (location.href !== initial.url && history.length > 1) history.back();

        if (trigger.tagName === "SUMMARY" && trigger.parentElement instanceof HTMLDetailsElement) trigger.parentElement.open = initial.expanded === "true";
      }

      if (location.href !== initial.url) return { restored: false, urlChanged: true };
      scrollTo(initial.scrollX, initial.scrollY);

      const witness = initial.witness;
      // Without aria-expanded, "null" === "null" says nothing: the revealed content must be gone, or no popup newly shown.
      const closed = !initial.stateless || (witness ? !witness.isConnected || !visible(witness) : [...openPopups()].every((popup) => initial.popups.has(popup)));

      return { restored: !trigger.isConnected || (expandedOf(trigger) === initial.expanded && closed), urlChanged: false };
    }

    case "hover-list": {
      state.tooltips = [];
      const pairs: Array<{ trigger: Element; tip: Element }> = [];

      for (const trigger of [...document.querySelectorAll("[aria-describedby]")].slice(0, 200)) {
        for (const id of (trigger.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) {
          const tip = document.getElementById(id);

          if (tip && (tip.getAttribute("role") === "tooltip" || !visible(tip))) pairs.push({ trigger, tip });
        }
      }

      for (const tip of [...document.querySelectorAll('[role="tooltip"]')].slice(0, 200)) {
        const trigger = tip.parentElement;

        if (trigger && trigger !== body && !pairs.some((pair) => pair.tip === tip)) pairs.push({ trigger, tip });
      }

      for (const pair of pairs) {
        if (state.tooltips.length >= 6) break;

        if (!visible(pair.tip) && visible(pair.trigger) && !pair.trigger.closest('[data-mauxi-overlay],[inert],[aria-hidden="true"]')) state.tooltips.push(pair);
      }

      return { count: state.tooltips.length };
    }

    case "hover-target": {
      const pair = state.tooltips[request.index];

      if (!pair?.trigger.isConnected) return { point: null, reason: "the trigger left the page" };
      const point = reveal(pair.trigger);

      return { point, label: `${pair.trigger.tagName.toLowerCase()} "${labelOf(pair.trigger)}"`, reason: point ? "" : `it is covered by ${coverOf(pair.trigger)}` };
    }

    case "hover-measure": {
      const pair = state.tooltips[request.index];

      if (!pair?.tip.isConnected || !visible(pair.tip)) return { opened: false, reason: "hovering it revealed nothing within 120 ms" };
      const rect = pair.tip.getBoundingClientRect();
      const issues: InteractionIssue[] = [];
      const edges = [rect.right > viewportWidth + 1 ? `ends ${round(rect.right - viewportWidth)}px past the right edge` : "", rect.left < -1 ? `starts ${round(-rect.left)}px before the left edge` : "", rect.top < -1 ? `starts ${round(-rect.top)}px above the top` : "", rect.bottom > viewportHeight + 1 ? `ends ${round(rect.bottom - viewportHeight)}px below the bottom` : ""].filter(Boolean);

      if (edges.length) issues.push({ kind: "hover-content", variant: "clipped", element: describe(pair.trigger), cause: describe(pair.tip), view: viewRect(pair.tip), overflowPx: round(Math.max(rect.right - viewportWidth, -rect.left, -rect.top, rect.bottom - viewportHeight)), detail: clip(`Hovering ${pair.trigger.tagName.toLowerCase()} "${labelOf(pair.trigger)}" shows ${rect.width > 0 ? `a ${round(rect.width)}px-wide` : "a"} tooltip that ${edges.join(" and ")} of the ${viewportWidth}×${viewportHeight} viewport, so part of it cannot be read.`, 512) });
      const trigger = pair.trigger.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), viewportWidth - 1);
      const candidates = [rect.top + rect.height / 2, rect.top + 2, rect.bottom - 2].map((y) => Math.min(Math.max(y, 1), viewportHeight - 1));
      const y = candidates.find((value) => value < trigger.top || value > trigger.bottom) ?? candidates[0];

      return { opened: true, issues, point: { x: round(x), y: round(y) } };
    }

    case "hover-check": {
      const pair = state.tooltips[request.index];

      if (!pair?.tip.isConnected || visible(pair.tip)) return { issues: [] };

      return { issues: [{ kind: "hover-content", variant: "unhoverable", element: describe(pair.trigger), cause: describe(pair.tip), view: viewRect(pair.trigger), detail: clip(`The tooltip of ${pair.trigger.tagName.toLowerCase()} "${labelOf(pair.trigger)}" disappears when the pointer moves from the trigger onto it.`, 512) }] };
    }

    case "cleanup": {
      const active = deepActive();

      if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
      state.sentinel?.remove();
      scrollTo(0, 0);
      Reflect.deleteProperty(window, KEY);

      return { done: true };
    }
  }
}
