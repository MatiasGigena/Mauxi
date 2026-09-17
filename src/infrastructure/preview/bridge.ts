import {
  getElementAtPoint,
  getElementContext,
  isElementGrabbable,
} from "react-grab/primitives";
import {
  BRIDGE_PROTOCOL,
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
let hoverTarget: Element | null = null;

const overlay = document.createElement("div");
overlay.dataset.mauxiOverlay = "true";
Object.assign(overlay.style, {
  position: "fixed",
  zIndex: "2147483647",
  pointerEvents: "none",
  display: "none",
  border: "2px solid #6d5dfc",
  borderRadius: "4px",
  background: "rgba(109, 93, 252, .10)",
  boxSizing: "border-box",
});

document.documentElement.append(overlay);

function send(message: Record<string, unknown>): void {
  if (!session || window.parent === window) return;
  window.parent.postMessage(
    { protocol: BRIDGE_PROTOCOL, session, generation, ...message },
    expectedParent === "null" ? "*" : expectedParent,
  );
}

function boundedText(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return "[redacted input]";
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function safeHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("input, textarea").forEach((node) => {
    node.removeAttribute("value");
    node.textContent = "[redacted]";
  });
  return clone.outerHTML.slice(0, 2_000);
}

function simpleSelector(element: Element): string {
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid=${JSON.stringify(testId)}]`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 6 && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`${part}#${CSS.escape(current.id)}`);
      break;
    }
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const peers = [...parentElement.children].filter((peer) => peer.tagName === current!.tagName);
      if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parentElement;
  }
  return parts.join(" > ");
}

function elementAt(x: number, y: number): Element | null {
  const target = getElementAtPoint(x, y, {
    filter: (candidate) => !candidate.hasAttribute("data-mauxi-overlay") && isElementGrabbable(candidate),
  });
  return target ?? document.elementFromPoint(x, y);
}

function drawOutline(element: Element | null): void {
  hoverTarget = element;
  if (!element) {
    overlay.style.display = "none";
    return;
  }
  const bounds = element.getBoundingClientRect();
  Object.assign(overlay.style, {
    display: "block",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
}

async function describe(element: Element, clientX: number, clientY: number) {
  let context: Awaited<ReturnType<typeof getElementContext>> | null = null;
  try {
    context = await getElementContext(element);
  } catch (error) {
    console.warn("[Mauxi] React Grab could not resolve context", error);
  }

  const source: SourceLocation = context?.filePath
    ? {
        filePath: context.filePath,
        lineNumber: context.lineNumber,
        columnNumber: context.columnNumber,
        componentName: context.componentName,
        method: "react-grab",
        fileFingerprint: null,
      }
    : {
        filePath: "",
        lineNumber: null,
        columnNumber: null,
        componentName: context?.componentName ?? null,
        method: "unresolved",
        fileFingerprint: null,
      };
  const bounds = element.getBoundingClientRect();
  const styles = getComputedStyle(element);
  const selector = context?.selector ?? simpleSelector(element);
  const text = boundedText(element);
  const fingerprint: ElementFingerprint = {
    selector,
    tag: element.tagName.toLowerCase(),
    testId: element.getAttribute("data-testid"),
    text,
    sourceKey: source.filePath ? `${source.filePath}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"}` : null,
  };

  return {
    selectionId: crypto.randomUUID(),
    documentGeneration: generation,
    capturedAt: new Date().toISOString(),
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    coordinates: { clientX, clientY, space: "preview-css-pixels" as const },
    element: {
      tag: fingerprint.tag,
      label: element.getAttribute("aria-label") ?? (text.slice(0, 80) || fingerprint.tag),
      role: element.getAttribute("role"),
      html: safeHtml(element),
    },
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    source,
    fingerprint,
    computedStyles: {
      display: styles.display,
      position: styles.position,
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      font: styles.font,
      padding: styles.padding,
      margin: styles.margin,
    },
  };
}

function cancelPageAction(event: Event): void {
  if (!selectionEnabled) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

document.addEventListener("pointermove", (event) => {
  if (selectionEnabled) drawOutline(elementAt(event.clientX, event.clientY));
}, true);
for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"] as const) {
  document.addEventListener(type, cancelPageAction, true);
}
document.addEventListener("click", async (event) => {
  if (!selectionEnabled) return;
  cancelPageAction(event);
  const target = hoverTarget ?? elementAt(event.clientX, event.clientY);
  if (!target) return;
  const revision = routeRevision;
  const capture = await describe(target, event.clientX, event.clientY);
  // Source resolution may finish after a router replaces the selected page.
  if (revision !== routeRevision || !target.isConnected || !selectionEnabled) return;
  send({ kind: "selection", capture });
}, true);

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || event.origin !== expectedParent) return;
  try { if (JSON.stringify(event.data).length > 65_536) return; } catch { return; }
  if (!isShellMessage(event.data)) return;
  const message = event.data;
  if (message.session !== session) return;
  if (message.kind === "connect") { reportReady(); return; }
  if (message.generation !== generation) return;
  if (message.kind === "reload") { location.reload(); return; }
  if (message.kind === "navigate") {
    const route = supportedRoute(message.route, location.origin);
    if (!route) return;
    navigationId = message.navigationId;
    unsafeRoute = false;
    saveBootstrap();
    location.assign(route);
    return;
  }
  if (message.kind === "selection-mode") {
    selectionEnabled = message.enabled;
    document.documentElement.style.cursor = message.enabled ? "crosshair" : "";
    if (!message.enabled) drawOutline(null);
    return;
  }
  if (message.kind === "revalidate") {
    let candidate: Element | null = null;
    try { if (message.fingerprint.selector) candidate = document.querySelector(message.fingerprint.selector); } catch { /* invalid untrusted selector */ }
    const current = candidate
      ? {
          selector: simpleSelector(candidate),
          tag: candidate.tagName.toLowerCase(),
          testId: candidate.getAttribute("data-testid"),
          text: boundedText(candidate),
          sourceKey: message.fingerprint.sourceKey,
        }
      : null;
    const valid = Boolean(
      current &&
      current.tag === message.fingerprint.tag &&
      current.testId === message.fingerprint.testId &&
      current.text === message.fingerprint.text,
    );
    send({
      kind: "revalidation",
      selectionId: message.selectionId,
      status: valid ? "valid" : "stale",
      reason: valid ? undefined : "The original DOM fingerprint no longer identifies the same rendered element.",
    });
  }
});

// Observe URLs only: never serialize history state, clicks, POST bodies or scroll.
function reportRoute() {
  if (reportedUrl !== location.href) {
    reportedUrl = location.href;
    reportedSafe = !unsafeRoute;
    // A form marker belongs to its resulting navigation, not every later route.
    // Same-URL history updates must neither consume a pending form marker nor
    // relabel an already-reported form destination as safe.
    unsafeRoute = false;
    routeRevision++;
    drawOutline(null);
  }
  send({ kind: "route", url: location.href, navigationId, safe: reportedSafe });
  navigationId = null;
  saveBootstrap();
}
for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method];
  history[method] = function (...args: Parameters<History[typeof method]>) {
    original.apply(this, args);
    reportRoute();
  };
}
window.addEventListener("popstate", reportRoute);
window.addEventListener("hashchange", reportRoute);
function markFormNavigation() {
  unsafeRoute = true;
  saveBootstrap();
}
// Native submit() intentionally skips the submit event (requestSubmit does not).
// Keep native validation/dispatch behavior, while covering this separate path.
const nativeSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function () {
  if (selectionEnabled) return;
  const previousUnsafe = unsafeRoute;
  markFormNavigation();
  try { return nativeSubmit.call(this); }
  catch (error) { unsafeRoute = previousUnsafe; saveBootstrap(); throw error; }
};
document.addEventListener("submit", (event) => {
  if (selectionEnabled) { cancelPageAction(event); return; }
  markFormNavigation();
}, true);
document.addEventListener("keydown", (event) => {
  if (selectionEnabled && event.key === "Escape") { cancelPageAction(event); send({ kind: "selection-cancelled" }); }
  if (selectionEnabled && (event.key === "Enter" || event.key === " ")) cancelPageAction(event);
}, true);
document.addEventListener("click", (event) => {
  if (!selectionEnabled && event.target instanceof Element) {
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;
    // Keep the live document intact for an external link. The Electron request
    // boundary also denies scripted navigations and redirects off-origin.
    if (new URL(anchor.href, location.href).origin !== location.origin) { event.preventDefault(); send({ kind: "navigation-blocked" }); return; }
    unsafeRoute = false; saveBootstrap();
  }
}, true);

function reportReady() {
  send({ kind: "ready", url: location.href, viewport: { width: innerWidth, height: innerHeight }, reactGrab: true, previewId });
}
reportReady();
reportRoute();
