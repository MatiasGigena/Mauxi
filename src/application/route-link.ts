import type { PreviewId } from "./preview-contract";

export const BRIDGE_PARAMS = ["mauxiSession", "mauxiPreview", "mauxiParent"];
export function projectRoute(value: string, origin: string): string | null {
  try {
    if (value.length > 4096) return null;
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    BRIDGE_PARAMS.forEach((key) => url.searchParams.delete(key));
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
// Deliberately conservative. These are navigations, not replayable browser actions.
// Applications with custom action-like GET routes must unlink navigation.
export function supportedRoute(value: string, origin: string): string | null {
  const route = projectRoute(value, origin);
  if (!route) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(route); } catch { return null; }
  if (/(?:^|[\/#?&=._-])(api|auth|oauth\d*|sso|login|logout|signin|signout|callback|redirect|action|actions|checkout|payment|delete|unsubscribe)(?:$|[\/#?&=._-])/i.test(decoded)) return null;
  if (/[?&#](?:[^=&#]*(?:token|secret|password|code|state|nonce|assertion|credential|signature)[^=&#]*)=/i.test(decoded)) return null;
  return route;
}
export interface RouteCommand { previewId: PreviewId; route: string; navigationId: string }
export class RouteLink {
  private routes: Partial<Record<PreviewId, string>> = {};
  private safe: Partial<Record<PreviewId, boolean>> = {};
  constructor(private readonly origin: string) {}
  observe(previewId: PreviewId, url: string, navigationId: string | null, linked: boolean, safe = true): RouteCommand | null {
    const route = projectRoute(url, this.origin);
    const previous = this.routes[previewId];
    if (route === null) return null;
    this.routes[previewId] = route;
    this.safe[previewId] = safe;
    if (previous === undefined || previous === route || navigationId || !linked || !safe) return null;
    return this.copy(previewId);
  }
  copy(previewId: PreviewId): RouteCommand | null {
    const route = supportedRoute(this.routes[previewId] ?? "", this.origin);
    const peer = previewId === "desktop" ? "mobile" : "desktop";
    if (!this.safe[previewId] || !this.routes[previewId] || route === null || this.routes[peer] === route) return null;
    // Optimistically record the destination. Acknowledgements/redirects carry a token
    // across the new document and never feed back, including after unlinking.
    this.routes[peer] = route;
    return { previewId: peer, route, navigationId: crypto.randomUUID() };
  }
}
