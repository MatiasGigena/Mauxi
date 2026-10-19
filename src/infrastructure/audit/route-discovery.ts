import type { BrowserWindow } from "electron";
import { isPageLinks, type DiscoveredRoute, type PageLinks, type RouteDiscovery } from "../../application/audit-contract";
import { linkVerdict, SITE_ROUTE_LIMIT } from "../../application/audit-site";
import type { Fence } from "./navigation-fence";

export const LINKS_PER_PAGE = 400;
const PAGE_LIMIT_MS = 10_000;

/**
 * Runs inside the page: reads the resolved targets of plain links. Serialized with Function.prototype.toString,
 * so it must not reference anything outside its own body.
 */
export function collectLinks(limit: number): PageLinks {
  const anchors = Array.from(document.querySelectorAll("a[href], area[href]"));
  const links: PageLinks["links"] = [];

  for (const anchor of anchors) {
    if (links.length >= limit) break;

    if (!(anchor instanceof HTMLAnchorElement) && !(anchor instanceof HTMLAreaElement)) continue;

    if (anchor.href.length <= 4_096) links.push({ href: anchor.href, download: anchor.hasAttribute("download") });
  }

  return { url: location.href.slice(0, 4_096), links, total: anchors.length };
}

const COLLECT = `(${collectLinks.toString()})(${LINKS_PER_PAGE})`;
const SETTLE = `Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 1500))]).then(() => new Promise(r => setTimeout(r, 250)))`;

export interface DiscoveryRequest { url: string; route: string; origin: string; depth: number }

function within<T>(work: Promise<T>, ms: number, signal: AbortSignal, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Breadth-first walk of same-origin links from the starting route: the start page and, below the depth limit,
 * each page it links to. Only routes that pass the site-audit link policy are loaded or listed; the fence cancels
 * redirects to excluded routes before they are requested.
 */
export async function discoverRoutes(window: BrowserWindow, request: DiscoveryRequest, signal: AbortSignal, fence: Fence): Promise<RouteDiscovery> {
  const contents = window.webContents;
  const start = linkVerdict(request.url, request.origin);

  if (start.reason !== null) throw new Error(`The current route cannot start a site audit (${start.reason}). Open a regular page first.`);
  const startRoute = start.route;
  const found = new Map<string, DiscoveredRoute>([[startRoute, { route: startRoute, depth: 0, from: null }]]);
  const excluded = new Map<string, string>();
  const queue = [startRoute];
  let external = 0; let visited = 0; let truncated = false;

  for (let index = 0; index < queue.length; index++) {
    const route = queue[index];
    const node = found.get(route);

    if (!node || node.depth >= request.depth) continue;
    signal.throwIfAborted();
    let links: PageLinks;

    try {
      fence.refused = null;

      // A cancelled redirect fails the load; the refusal says where it led.
      try { await within(window.loadURL(new URL(route, request.origin).href), PAGE_LIMIT_MS, signal, `${route} did not load within ${PAGE_LIMIT_MS / 1000}s.`); }
      catch (error) { if (!fence.refused || signal.aborted) throw error; }

      const landed = fence.refused ?? linkVerdict(contents.getURL(), request.origin);

      if (landed.reason !== null || landed.route !== route && found.has(landed.route)) {
        if (node.depth === 0) throw new Error(landed.reason === null ? "The start page redirects." : "The start page redirects outside the allowed routes.");
        found.delete(route);
        excluded.set(route, landed.reason === null ? `Redirects to ${landed.route}` : `Redirects to an excluded route (${landed.reason})`);
        continue;
      }

      await within(contents.executeJavaScript(SETTLE), PAGE_LIMIT_MS, signal, `${route} did not settle.`);
      const value: unknown = await within(contents.executeJavaScript(COLLECT), PAGE_LIMIT_MS, signal, `Reading links on ${route} timed out.`);

      if (!isPageLinks(value)) throw new Error(`${route} returned invalid links.`);
      links = value;
    } catch (error) {
      signal.throwIfAborted();

      if (node.depth === 0) throw error;
      continue;
    }

    visited++;

    if (links.total > links.links.length) truncated = true;

    for (const link of links.links) {
      const verdict = linkVerdict(link.href, request.origin, link.download);

      if (verdict.route === null) { external++; continue; }

      // A download attribute excludes that link, not a later ordinary link to the same page.
      if (found.has(verdict.route) || excluded.has(verdict.route) && excluded.get(verdict.route) !== "Download link") continue;

      if (verdict.reason !== null) { excluded.set(verdict.route, verdict.reason); continue; }

      if (found.size >= SITE_ROUTE_LIMIT) { truncated = true; continue; }

      excluded.delete(verdict.route);
      found.set(verdict.route, { route: verdict.route, depth: node.depth + 1, from: route });
      queue.push(verdict.route);
    }
  }

  return { start: startRoute, routes: [...found.values()], excluded: [...excluded].map(([route, reason]) => ({ route, reason })).slice(0, 60), external, pagesVisited: visited, truncated };
}
