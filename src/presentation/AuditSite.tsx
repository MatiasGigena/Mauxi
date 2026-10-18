import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ChevronRight, LoaderCircle, Play, Plus } from "lucide-react";
import { formatRanges, type AuditReport, type AuditScope, type AuditSitePage, type AuditSiteReport, type RouteDiscovery } from "../application/audit-contract";
import { linkVerdict, mergeRanges, SITE_ROUTE_LIMIT } from "../application/audit-site";
import { WidthRuler } from "./AuditPanel";

/** off: the single-route panel; setup: choosing pages; summary: all pages; page: one page of the site audit. */
export type SiteMode = "off" | "setup" | "summary" | "page";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

/** Site audit state: discovery, the batch summary pushed by the host, and which page's report the panel shows. */
export function useSiteAudit(scope: AuditScope, events: { onOpen: (report: AuditReport) => void; onActivity: () => void }) {
  const [mode, setMode] = useState<SiteMode>("off");
  const [discovery, setDiscovery] = useState<RouteDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [report, setReport] = useState<AuditSiteReport | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const latest = useRef({ report, events }); latest.current = { report, events };

  useEffect(() => {
    if (!window.mauxi) return;

    return window.mauxi.onAuditSite((next) => {
      setReport(next);

      if (next.state !== "running") return;
      setMode((current) => current === "page" ? current : "summary");
      latest.current.events.onActivity();
    });
  }, []);

  async function discover(route: string) {
    if (!window.mauxi) return;
    setMode("setup"); setDiscovery(null); setDiscovering(true); setError("");

    try { setDiscovery(await window.mauxi.auditDiscover({ ...scope, route })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setDiscovering(false); }
  }

  async function start(routes: string[]) {
    if (!window.mauxi || !routes.length) return;
    setMode("summary"); setPage(null); setError("");

    try { setReport(await window.mauxi.auditSite({ ...scope, routes })); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function open(route: string) {
    if (!window.mauxi) return;
    setError("");

    try {
      const opened = await window.mauxi.auditOpen({ ...scope, route });

      if (!opened) { setError(`The report for ${route} is no longer kept. Re-run that page.`);

 return; }

      setPage(route); setMode("page");
      events.onOpen(opened);
    } catch (cause) { setError(errorText(cause)); }
  }

  /** A single-route report arrived: stay in the site view when it belongs to one of its pages. */
  const reportArrived = useCallback((arrived: AuditReport) => {
    const known = !!latest.current.report?.pages.some((item) => item.route === arrived.route);
    setMode((current) => current !== "off" && known ? "page" : "off");

    if (known) setPage(arrived.route);
  }, []);

  function close() {
    if (discovering) void window.mauxi?.auditCancel();
    setMode("off"); setError("");
  }

  return { mode, discovery, discovering, report, page, error, running: report?.state === "running", discover, start, open, reportArrived, close, back: () => setMode("summary") };
}

export function SiteSetup({ discovery, discovering, origin, onStart, onCancel }: {
  discovery: RouteDiscovery | null; discovering: boolean; origin: string; onStart: (routes: string[]) => void; onCancel: () => void;
}) {
  const [extra, setExtra] = useState<string[]>([]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const found = discovery?.routes ?? [];
  const routes = [...found.map((item) => item.route), ...extra];
  const selected = routes.filter((route) => !unchecked.has(route));

  function toggle(route: string) {
    setUnchecked((current) => {
      const next = new Set(current);

      if (next.has(route)) next.delete(route); else next.add(route);

      return next;
    });
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();

    if (!value.startsWith("/")) { setDraftError("Enter a route that starts with /.");

 return; }

    const verdict = linkVerdict(value, origin);

    if (verdict.reason !== null) { setDraftError(`Not added (${verdict.reason}).`);

 return; }

    if (routes.includes(verdict.route)) { setDraftError("That page is already listed.");

 return; }

    if (routes.length >= SITE_ROUTE_LIMIT) { setDraftError(`A site audit covers at most ${SITE_ROUTE_LIMIT} pages.`);

 return; }

    setExtra((current) => [...current, verdict.route]); setDraft(""); setDraftError("");
  }

  return <section className="site-setup" aria-label="Site audit setup">
    {discovering && <p className="site-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Finding linked pages…</p>}
    {discovery && !discovering && <>
      <p className="site-lead">{found.length === 1 ? "No other pages are linked from" : `${found.length} pages found from`} <code>{discovery.start}</code>. Each checked page is audited across every width, one after another.</p>
      <ul className="site-routes" aria-label="Pages to audit">
        {routes.map((route) => {
          const item = found.find((candidate) => candidate.route === route);

          return <li key={route}><label>
            <input type="checkbox" checked={!unchecked.has(route)} onChange={() => toggle(route)} />
            <code>{route}</code>
            <span>{!item ? "Added" : item.depth === 0 ? "Current page" : `Linked from ${item.from}`}</span>
          </label></li>;
        })}
      </ul>
      <form className="site-add" onSubmit={add}>
        <input aria-label="Add a route" placeholder="/pricing" value={draft} spellCheck={false} onChange={(event) => { setDraft(event.target.value); setDraftError(""); }} />
        <button type="submit" disabled={!draft.trim()}><Plus size={13} aria-hidden="true" /><span>Add</span></button>
      </form>
      {draftError && <p className="site-field-error" role="alert">{draftError}</p>}
      {discovery.truncated && <p className="site-note">Discovery stopped at {SITE_ROUTE_LIMIT} pages or 400 links per page. Add a missing page by hand.</p>}
      {discovery.excluded.length > 0 && <details className="site-skipped">
        <summary>Skipped links<span>{discovery.excluded.length}</span></summary>
        <ul aria-label="Skipped links">{discovery.excluded.map((item) => <li key={item.route}><code>{item.route}</code><span>{item.reason}</span></li>)}</ul>
      </details>}
    </>}
    <div className="site-actions">
      <button type="button" className="audit-run" disabled={discovering || !selected.length} onClick={() => onStart(selected)}><Play size={14} aria-hidden="true" /><span>{`Audit ${selected.length} ${selected.length === 1 ? "page" : "pages"}`}</span></button>
      <button type="button" className="site-cancel" onClick={onCancel}>Cancel</button>
    </div>
  </section>;
}

const STATUS: Record<AuditSitePage["status"], string> = { pending: "Waiting", running: "Auditing…", done: "Done", failed: "Failed", skipped: "Skipped" };

function SitePageRow({ page, onOpen }: { page: AuditSitePage; onOpen: () => void }) {
  const ranges = mergeRanges(page.bugRanges);
  const summary = page.summary;

  return <li className="site-page" data-route={page.route} data-status={page.status}>
    <button type="button" className="site-page-open" disabled={!summary} onClick={onOpen} aria-label={`Open ${page.route}`}>
      <span className="site-page-head">
        <code>{page.route}</code>
        {summary ? <ChevronRight size={14} aria-hidden="true" /> : <span className="site-page-status">{page.status === "running" && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{STATUS[page.status]}</span>}
      </span>
      {summary && <span className="site-page-counts">
        <span data-kind="bug">{summary.bug} {summary.bug === 1 ? "bug" : "bugs"}</span>
        <span data-kind="review">{summary.review} review</span>
        <span data-kind="intentional">{summary.intentional} intentional</span>
        {page.resolved > 0 && <span data-kind="resolved">{page.resolved} resolved</span>}
      </span>}
    </button>
    {summary && <>
      <WidthRuler ranges={ranges} severity="serious" label={ranges.length ? `Bugs measured at ${formatRanges(ranges)}` : "No bugs measured at any width"} />
      <p className="site-page-widths">{ranges.length ? `Bugs at ${formatRanges(ranges)}` : "No bugs at any width"}</p>
    </>}
    {page.error && <p className="site-page-error">{page.error}</p>}
  </li>;
}

export function SiteSummary({ report, onOpen }: { report: AuditSiteReport; onOpen: (route: string) => void }) {
  const totals = report.pages.reduce((sum, page) => ({ audited: sum.audited + (page.summary ? 1 : 0), bug: sum.bug + (page.summary?.bug ?? 0), review: sum.review + (page.summary?.review ?? 0), intentional: sum.intentional + (page.summary?.intentional ?? 0) }), { audited: 0, bug: 0, review: 0, intentional: 0 });

  return <section className="site-summary" aria-label="Site summary">
    <div className="audit-overview">
      <dl className="audit-summary">
        <div data-kind="pages"><dt>Pages</dt><dd>{totals.audited}/{report.pages.length}</dd></div>
        <div data-kind="bug"><dt>Bugs</dt><dd>{totals.bug}</dd></div>
        <div data-kind="review"><dt>Review</dt><dd>{totals.review}</dd></div>
        <div data-kind="intentional"><dt>Intentional</dt><dd>{totals.intentional}</dd></div>
      </dl>
    </div>
    <ol className="site-pages" aria-label="Audited pages">{report.pages.map((page) => <SitePageRow key={page.route} page={page} onOpen={() => onOpen(page.route)} />)}</ol>
  </section>;
}

export function SitePageBar({ report, page, onBack }: { report: AuditSiteReport | null; page: string | null; onBack: () => void }) {
  const index = report?.pages.findIndex((item) => item.route === page) ?? -1;

  return <div className="site-pagebar">
    <button type="button" className="site-back" onClick={onBack}><ArrowLeft size={13} aria-hidden="true" /><span>All pages</span></button>
    {report && index >= 0 && <span>Page {index + 1} of {report.pages.length}</span>}
  </div>;
}
