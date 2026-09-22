import {
  getElementAtPoint,
  getElementContext,
  getElementsAtPoint,
  isElementGrabbable,
} from "react-grab/primitives";
import {
  BRIDGE_PROTOCOL,
  type ComponentOwner,
  type DomAncestryEntry,
  type ElementFingerprint,
  isShellMessage,
  type SourceLocation,
} from "../../application/preview-contract";
import { supportedRoute } from "../../application/route-link";

const params = new URLSearchParams(location.search);
// Frame-local bootstrap survives ordinary same-origin document navigation. This
// is untrusted transport metadata, never an authority for host IPC.
let previous: Record<string, unknown> = {};
try { if (window.name.startsWith("mauxi:")) previous = JSON.parse(window.name.slice(6)); } catch { /* fresh frame */ }
if (previous.origin !== location.origin) previous = {};
const session = params.get("mauxiSession") ?? (typeof previous.session === "string" ? previous.session : null);
const previewId = params.get("mauxiPreview") ?? previous.previewId;
const expectedParent = params.get("mauxiParent") ?? (typeof previous.parent === "string" ? previous.parent : "null");
let navigationId = typeof previous.navigationId === "string" ? previous.navigationId : null;
let unsafeRoute = previous.unsafeRoute === true;
let reportedUrl: string | null = null;
let reportedSafe = true;
let routeRevision = 0;
function saveBootstrap() {
  window.name = `mauxi:${JSON.stringify({ origin: location.origin, session, previewId, parent: expectedParent, navigationId, unsafeRoute })}`;
}
saveBootstrap();
const generation = crypto.randomUUID();
let selectionEnabled = false;
let pickerHidden = false;
let hoverTarget: Element | null = null;
let hoverBase: Element | null = null;
let refinementPath: Element[] = [];
let refinementIndex = 0;
let overlapTargets: Element[] = [];
let overlapIndex = 0;
let pointer = { x: 0, y: 0 };
let trackingPicker = false;
const instanceKeys = new WeakMap<Element, string>();
const selectedElements = new Map<string, Element>();
const childFrameShields = new Map<HTMLIFrameElement, HTMLDivElement>();
const frameShieldOwners = new WeakMap<Element, HTMLIFrameElement>();

const overlay = document.createElement("div");
overlay.dataset.mauxiOverlay = "true";
Object.assign(overlay.style, {
  position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none",
  border: "2px solid #6d5dfc", borderRadius: "4px", background: "rgba(109, 93, 252, .10)", boxSizing: "border-box",
});
const pickerLabel = document.createElement("div");
pickerLabel.dataset.mauxiOverlay = "true";
Object.assign(pickerLabel.style, {
  position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none", maxWidth: "min(32rem, calc(100vw - 1rem))",
  padding: "6px 9px", borderRadius: "6px", background: "#241f2d", color: "white", font: "600 12px/1.35 system-ui, sans-serif",
  boxShadow: "0 3px 14px #0005", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
});
document.documentElement.append(overlay, pickerLabel);

function send(message: Record<string, unknown>): void {
  if (!session || window.parent === window) return;
  window.parent.postMessage({ protocol: BRIDGE_PROTOCOL, session, generation, ...message }, expectedParent === "null" ? "*" : expectedParent);
}

const SENSITIVE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
function isSensitiveElement(element: Element): boolean {
  return element.matches(SENSITIVE_SELECTOR) || Boolean(element.closest('[contenteditable]:not([contenteditable="false"])'));
}
function boundedText(element: Element): string {
  if (isSensitiveElement(element)) return "[redacted input]";
  const clone = element.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(SENSITIVE_SELECTOR)) node.replaceWith(document.createTextNode("[redacted input]"));
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function safeHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  const sensitive = [...(clone.matches(SENSITIVE_SELECTOR) ? [clone] : []), ...clone.querySelectorAll(SENSITIVE_SELECTOR)];
  for (const node of sensitive) {
    node.removeAttribute("value"); node.removeAttribute("checked"); node.removeAttribute("selected");
    if (node instanceof HTMLInputElement) node.setAttribute("data-mauxi-value", "[redacted]");
    else node.textContent = "[redacted]";
  }
  return clone.outerHTML.slice(0, 2_000);
}

function simpleSelector(element: Element): string {
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid=${JSON.stringify(testId)}]`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 6 && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if (current.id) { parts.unshift(`${part}#${CSS.escape(current.id)}`); break; }
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const peers = [...parentElement.children].filter((peer) => peer.tagName === current!.tagName);
      if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
    }
    parts.unshift(part); current = parentElement;
  }
  return parts.join(" > ");
}

function selectable(candidate: Element): boolean {
  return !candidate.closest("[data-mauxi-overlay]") && isElementGrabbable(candidate);
}
function elementAt(x: number, y: number): Element | null {
  const target = getElementAtPoint(x, y, { filter: selectable });
  if (target) return target;
  const fallback = document.elementFromPoint(x, y);
  if (!fallback) return null;
  return frameShieldOwners.get(fallback) ?? (fallback.closest("[data-mauxi-overlay]") ? null : fallback);
}
function hierarchy(element: Element): Element[] {
  const result: Element[] = [];
  let current: Element | null = element;
  while (current && result.length < 12 && current !== document.documentElement && current !== document.body) {
    if (selectable(current)) result.push(current);
    current = current.parentElement;
  }
  return result;
}
function instanceKey(element: Element): string {
  let key = instanceKeys.get(element);
  if (!key) { key = crypto.randomUUID(); instanceKeys.set(element, key); }
  return key;
}

function drawOutline(element: Element | null): void {
  hoverTarget = element;
  if (!element || !selectionEnabled || pickerHidden || !element.isConnected) {
    overlay.style.display = "none"; pickerLabel.style.display = "none"; return;
  }
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0 || bounds.bottom < 0 || bounds.right < 0 || bounds.top > innerHeight || bounds.left > innerWidth) {
    overlay.style.display = "none"; pickerLabel.style.display = "none"; return;
  }
  Object.assign(overlay.style, { display: "block", left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  pickerLabel.textContent = `${element.tagName.toLowerCase()} · DOM ${refinementIndex + 1}/${Math.max(1, refinementPath.length)} · ↑ parent ↓ child · [ ] overlap`;
  const labelTop = bounds.top > 38 ? Math.max(4, bounds.top - 32) : Math.min(innerHeight - 32, bounds.bottom + 5);
  Object.assign(pickerLabel.style, { display: "block", left: `${Math.max(4, Math.min(bounds.left, innerWidth - 250))}px`, top: `${labelTop}px` });
}
function updatePoint(x: number, y: number): void {
  pointer = { x, y };
  const next = elementAt(x, y);
  if (!next) { hoverBase = null; refinementPath = []; overlapTargets = []; drawOutline(null); return; }
  if (next !== hoverBase) {
    hoverBase = next; refinementIndex = 0; overlapIndex = 0;
    overlapTargets = getElementsAtPoint(x, y, { filter: selectable }).filter((item, index, all) => all.indexOf(item) === index).slice(0, 16);
    refinementPath = hierarchy(next);
  }
  drawOutline(refinementPath[refinementIndex] ?? next);
}
function cycleOverlap(delta: number): void {
  if (!overlapTargets.length) return;
  overlapIndex = (overlapIndex + delta + overlapTargets.length) % overlapTargets.length;
  hoverBase = overlapTargets[overlapIndex]; refinementPath = hierarchy(hoverBase); refinementIndex = 0;
  drawOutline(refinementPath[0] ?? hoverBase);
}

function ownershipFor(filePath: string | null): "application" | "library" | "unknown" {
  if (!filePath) return "unknown";
  if (/(^|[\\/])(?:node_modules|next[\\/]dist|react-dom)([\\/]|$)/i.test(filePath)) return "library";
  return /\.(?:[cm]?[jt]sx?)(?:[?#].*)?$/i.test(filePath) ? "application" : "unknown";
}
function isCrossOriginFrame(element: HTMLIFrameElement): boolean {
  try { return new URL(element.src || location.href, location.href).origin !== location.origin; }
  catch { return true; }
}
function syncChildFrameShields(): void {
  // Events inside any child browsing context do not bubble to this document.
  // Shield every iframe while picking so same-origin controls cannot activate;
  // cross-origin frames remain explicitly unsupported source targets.
  const wanted = selectionEnabled ? new Set([...document.querySelectorAll("iframe")]) : new Set<HTMLIFrameElement>();
  for (const [frame, shield] of childFrameShields) {
    if (!wanted.has(frame) || !frame.isConnected) { shield.remove(); childFrameShields.delete(frame); }
  }
  for (const frame of wanted) {
    let shield = childFrameShields.get(frame);
    if (!shield) {
      shield = document.createElement("div"); shield.dataset.mauxiOverlay = "true"; shield.dataset.mauxiFrameShield = "true";
      const frameTestId = frame.getAttribute("data-testid"); if (frameTestId) shield.dataset.mauxiFrameTarget = frameTestId;
      Object.assign(shield.style, { position: "fixed", zIndex: "2147483646", background: "transparent", cursor: "crosshair" });
      frameShieldOwners.set(shield, frame); document.documentElement.append(shield); childFrameShields.set(frame, shield);
      shield.addEventListener("pointermove", (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        hoverBase = frame; refinementPath = hierarchy(frame); refinementIndex = 0; hoverTarget = frame; drawOutline(frame);
      });
    }
    const bounds = frame.getBoundingClientRect();
    Object.assign(shield.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, display: pickerHidden ? "none" : "block" });
  }
}
function unsupportedReason(element: Element): string | null {
  if (element instanceof HTMLCanvasElement) return "Canvas/WebGL pixels do not expose editable DOM source targets.";
  if (element instanceof HTMLIFrameElement && isCrossOriginFrame(element)) return "Third-party child frames are outside the supported picker boundary.";
  return null;
}
function ancestryFor(element: Element): DomAncestryEntry[] {
  return hierarchy(element).map((entry, index) => ({
    tag: entry.tagName.toLowerCase(), label: entry.getAttribute("aria-label") ?? (boundedText(entry).slice(0, 80) || entry.tagName.toLowerCase()),
    selector: simpleSelector(entry), testId: entry.getAttribute("data-testid"), selected: index === 0,
  }));
}

async function describe(element: Element, clientX: number, clientY: number, selectionId: string) {
  let context: Awaited<ReturnType<typeof getElementContext>> | null = null;
  try { context = await getElementContext(element); }
  catch (error) { console.warn("[Mauxi] React Grab could not resolve context", error); }
  const sourceOwnership = ownershipFor(context?.filePath ?? null);
  const source: SourceLocation = context?.filePath ? {
    filePath: context.filePath, lineNumber: context.lineNumber, columnNumber: context.columnNumber, componentName: context.componentName,
    method: "react-grab", fileFingerprint: null, role: "jsx-element", ownership: sourceOwnership,
    verification: sourceOwnership === "library" ? "library" : "unverified",
  } : {
    filePath: "", lineNumber: null, columnNumber: null, componentName: context?.componentName ?? null,
    method: "unresolved", fileFingerprint: null, role: "unknown", ownership: "unknown", verification: "missing-or-ambiguous",
  };
  const owners: ComponentOwner[] = (context?.stack ?? []).slice(0, 32).flatMap((frame) => {
    const componentName = frame.functionName?.replace(/^at\s+/, "").slice(0, 256);
    // React stacks can include intrinsic host tags. Those describe DOM ancestry,
    // not component ownership, and are intentionally represented elsewhere.
    if (!componentName || !/^[A-Z]/.test(componentName)) return [];
    const filePath = frame.fileName?.slice(0, 1_024) ?? null;
    return [{ componentName, filePath, lineNumber: frame.lineNumber ?? null, columnNumber: frame.columnNumber ?? null, ownership: ownershipFor(filePath) }];
  }).slice(0, 16).map((owner, index) => ({ ...owner, role: index === 0 ? "component-owner" : "caller" }));
  const bounds = element.getBoundingClientRect();
  const styles = getComputedStyle(element);
  const selector = context?.selector ?? simpleSelector(element);
  const text = boundedText(element);
  const fingerprint: ElementFingerprint = {
    selector, tag: element.tagName.toLowerCase(), testId: element.getAttribute("data-testid"), text,
    sourceKey: source.filePath ? `${source.filePath}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"}` : null,
    instanceKey: instanceKey(element),
  };
  const padding = 48;
  const desiredWidth = Math.min(960, Math.max(1, bounds.width + padding * 2), innerWidth);
  const desiredHeight = Math.min(720, Math.max(1, bounds.height + padding * 2), innerHeight);
  const cropX = Math.max(0, Math.min(innerWidth - desiredWidth, bounds.x + bounds.width / 2 - desiredWidth / 2));
  const cropY = Math.max(0, Math.min(innerHeight - desiredHeight, bounds.y + bounds.height / 2 - desiredHeight / 2));
  const crop = { x: cropX, y: cropY, width: desiredWidth, height: desiredHeight, space: "preview-css-pixels" as const };
  const reason = unsupportedReason(element);
  return {
    selectionId, documentGeneration: generation, capturedAt: new Date().toISOString(), url: location.href,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    coordinates: { clientX, clientY, space: "preview-css-pixels" as const },
    element: { tag: fingerprint.tag, label: element.getAttribute("aria-label") ?? (text.slice(0, 80) || fingerprint.tag), role: element.getAttribute("role"), text, html: safeHtml(element) },
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, source,
    componentOwners: owners, domAncestry: ancestryFor(element), support: { status: reason ? "unsupported" as const : "supported" as const, reason },
    fingerprint,
    computedStyles: { display: styles.display, position: styles.position, color: styles.color, backgroundColor: styles.backgroundColor, font: styles.font, padding: styles.padding, margin: styles.margin, border: styles.border, borderRadius: styles.borderRadius, opacity: styles.opacity, zIndex: styles.zIndex },
    screenshot: { status: "pending" as const, crop },
  };
}

function cancelPageAction(event: Event): void {
  if (!selectionEnabled) return;
  event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
}
async function commitSelection(target: Element | null, clientX: number, clientY: number): Promise<void> {
  if (!selectionEnabled || !target) return;
  const revision = routeRevision;
  const selectionId = crypto.randomUUID();
  const capture = await describe(target, clientX, clientY, selectionId);
  if (revision !== routeRevision || !target.isConnected || !selectionEnabled) return;
  selectedElements.set(selectionId, target);
  while (selectedElements.size > 64) selectedElements.delete(selectedElements.keys().next().value!);
  // Keep interception active for multi-select, but remove picker chrome so the
  // shell can capture the attached element without the outline in the pixels.
  drawOutline(null);
  send({ kind: "selection", capture });
}

document.addEventListener("pointermove", (event) => { if (selectionEnabled) updatePoint(event.clientX, event.clientY); }, true);
for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "auxclick", "dblclick", "contextmenu"] as const) document.addEventListener(type, cancelPageAction, true);
document.addEventListener("click", (event) => {
  if (!selectionEnabled) return;
  cancelPageAction(event);
  const shieldOwner = event.target instanceof Element ? frameShieldOwners.get(event.target) : undefined;
  void commitSelection(shieldOwner ?? hoverTarget ?? elementAt(event.clientX, event.clientY), event.clientX, event.clientY);
}, true);
document.addEventListener("scroll", () => { if (selectionEnabled) drawOutline(hoverTarget); }, true);
function trackMovingTarget() {
  if (!selectionEnabled) { trackingPicker = false; return; }
  if (hoverTarget) drawOutline(hoverTarget);
  syncChildFrameShields();
  requestAnimationFrame(trackMovingTarget);
}
function startPickerTracking() {
  if (trackingPicker) return;
  trackingPicker = true; requestAnimationFrame(trackMovingTarget);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  // Chromium serializes messages FROM a file:// shell with the opaque origin
  // "null", even though location.origin in that shell is "file://". Window
  // identity and the session/document checks remain mandatory below.
  const parentOriginMatches = event.origin === expectedParent || (expectedParent === "file://" && event.origin === "null");
  if (event.source !== window.parent || !parentOriginMatches) return;
  try { if (JSON.stringify(event.data).length > 65_536) return; } catch { return; }
  if (!isShellMessage(event.data)) return;
  const message = event.data;
  if (message.session !== session) return;
  if (message.kind === "connect") { reportReady(); return; }
  if (message.generation !== generation) return;
  if (message.kind === "reload") { location.reload(); return; }
  if (message.kind === "navigate") {
    const route = supportedRoute(message.route, location.origin); if (!route) return;
    navigationId = message.navigationId; unsafeRoute = false; saveBootstrap(); location.assign(route); return;
  }
  if (message.kind === "selection-mode") {
    selectionEnabled = message.enabled; document.documentElement.style.cursor = message.enabled ? "crosshair" : "";
    if (!message.enabled) { hoverBase = null; refinementPath = []; overlapTargets = []; drawOutline(null); }
    else startPickerTracking();
    syncChildFrameShields();
    return;
  }
  if (message.kind === "picker-visibility") {
    pickerHidden = message.hidden; drawOutline(message.hidden ? null : hoverTarget); return;
  }
  if (message.kind === "picker-refine") {
    if (!selectionEnabled) return;
    if (message.action === "parent" || message.action === "child") {
      refinementIndex = Math.max(0, Math.min(refinementPath.length - 1, refinementIndex + (message.action === "parent" ? 1 : -1)));
      drawOutline(refinementPath[refinementIndex] ?? hoverBase);
    } else if (message.action === "overlap-next" || message.action === "overlap-previous") {
      cycleOverlap(message.action === "overlap-next" ? 1 : -1);
    } else {
      void commitSelection(hoverTarget, pointer.x, pointer.y);
    }
    return;
  }
  if (message.kind === "revalidate") {
    const candidate = selectedElements.get(message.selectionId) ?? null;
    const valid = Boolean(candidate && candidate.isConnected
      && instanceKey(candidate) === message.fingerprint.instanceKey
      && candidate.tagName.toLowerCase() === message.fingerprint.tag
      && candidate.getAttribute("data-testid") === message.fingerprint.testId
      && boundedText(candidate) === message.fingerprint.text);
    send({ kind: "revalidation", selectionId: message.selectionId, status: valid ? "valid" : "stale",
      reason: valid ? undefined : "The original rendered instance was removed or its identity changed." });
  }
});

function reportRoute() {
  if (reportedUrl !== location.href) {
    reportedUrl = location.href; reportedSafe = !unsafeRoute; unsafeRoute = false; routeRevision++; drawOutline(null);
  }
  send({ kind: "route", url: location.href, navigationId, safe: reportedSafe }); navigationId = null; saveBootstrap();
}
for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method];
  history[method] = function (...args: Parameters<History[typeof method]>) { original.apply(this, args); reportRoute(); };
}
window.addEventListener("popstate", reportRoute); window.addEventListener("hashchange", reportRoute);
function markFormNavigation() { unsafeRoute = true; saveBootstrap(); }
const nativeSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function () {
  if (selectionEnabled) return;
  const previousUnsafe = unsafeRoute; markFormNavigation();
  try { return nativeSubmit.call(this); } catch (error) { unsafeRoute = previousUnsafe; saveBootstrap(); throw error; }
};
document.addEventListener("submit", (event) => { if (selectionEnabled) { cancelPageAction(event); return; } markFormNavigation(); }, true);
document.addEventListener("keydown", (event) => {
  if (!selectionEnabled) return;
  if (event.key === "Escape") { cancelPageAction(event); send({ kind: "selection-cancelled" }); return; }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    cancelPageAction(event);
    refinementIndex = Math.max(0, Math.min(refinementPath.length - 1, refinementIndex + (event.key === "ArrowUp" ? 1 : -1)));
    drawOutline(refinementPath[refinementIndex] ?? hoverBase); return;
  }
  if (event.key === "[" || event.key === "]") { cancelPageAction(event); cycleOverlap(event.key === "]" ? 1 : -1); return; }
  if (event.key === "Enter") { cancelPageAction(event); void commitSelection(hoverTarget, pointer.x, pointer.y); return; }
  if (event.key === " ") cancelPageAction(event);
}, true);
document.addEventListener("click", (event) => {
  if (!selectionEnabled && event.target instanceof Element) {
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]"); if (!anchor) return;
    if (new URL(anchor.href, location.href).origin !== location.origin) { event.preventDefault(); send({ kind: "navigation-blocked" }); return; }
    unsafeRoute = false; saveBootstrap();
  }
}, true);

function reportReady() {
  send({ kind: "ready", url: location.href, viewport: { width: innerWidth, height: innerHeight }, reactGrab: true, previewId });
}
reportReady(); reportRoute();
