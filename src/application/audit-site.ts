import type { AuditReport, AuditSitePage } from "./audit-contract";
import { projectRoute, supportedRoute } from "./route-link";

/** Pages a site audit lists and runs at most, including the starting route. */
export const SITE_ROUTE_LIMIT = 12;

const PAGE_EXTENSIONS = new Set(["html", "htm", "php", "asp", "aspx", "jsp"]);

export type LinkVerdict = { route: string; reason: null } | { route: string | null; reason: string };

/**
 * Normalizes one link to a project route a site audit may load, or says why it is left out.
 * External links get a null route; the hash is dropped so anchors collapse onto their document.
 */
export function linkVerdict(href: string, origin: string, download = false): LinkVerdict {
  const projected = projectRoute(href, origin);

  if (projected === null) return { route: null, reason: "Outside the project" };
  const url = new URL(projected, origin);
  url.hash = "";
  const route = url.pathname + url.search;

  if (download) return { route, reason: "Download link" };

  if (/^\/(?:@|node_modules\/|_next\/|__)/.test(url.pathname)) return { route, reason: "Dev server internal" };
  const extension = /\.([a-z0-9]{1,8})$/i.exec(url.pathname)?.[1]?.toLowerCase();

  if (extension && !PAGE_EXTENSIONS.has(extension)) return { route, reason: `Not a page (.${extension})` };

  if (supportedRoute(route, origin) === null) return { route, reason: "Auth, API, action or credential route" };

  return { route, reason: null };
}

/** Union of possibly overlapping inclusive ranges, treating ranges one sweep step apart as touching. */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];

  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];

    if (last && from <= last[1] + 16) last[1] = Math.max(last[1], to); else merged.push([from, to]);
  }

  return merged;
}

export function sitePage(report: AuditReport): AuditSitePage {
  const bugRanges = report.findings.flatMap((finding) => finding.classification === "bug" ? finding.ranges : []).slice(0, 64);

  return { route: report.route, status: "done", summary: report.summary, bugRanges, resolved: report.resolved.length, durationMs: report.durationMs };
}
