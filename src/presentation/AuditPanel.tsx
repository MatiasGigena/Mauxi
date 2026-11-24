import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bot, Check, ChevronDown, Compass, Eye, EyeOff, Keyboard, Layers, LoaderCircle, PanelRightClose, Play, RotateCcw, ScanSearch, Square, Undo2 } from "lucide-react";
import { AUDIT_PROFILES, formatRanges, type AuditFinding, type AuditProgress, type AuditReport, type FindingClassification } from "../application/audit-contract";
import { profileTag, seenOn } from "../application/audit-layout";
import { scopePosition } from "./WidthScope";

const TICKS = [320, 768, 1280, 1920];

const GROUPS: Array<{ id: FindingClassification; label: string; hint: string }> = [
  { id: "bug", label: "Bugs", hint: "Measured failures to fix" },
  { id: "review", label: "Needs review", hint: "Probably accidental; you decide" },
  { id: "intentional", label: "Intentional, with gaps", hint: "Deliberate patterns missing accessibility" },
];

const CHECKS = ["Reflow and zoom, 320 to 1920px", "Text spacing and target size", "Keyboard focus, menus and tooltips", "Contrast, names, labels and ARIA"];

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

/** What a run is doing, for the panel and the canvas matrix title. */
export function progressText(progress: AuditProgress | null): string {
  const profile = progress?.profile && AUDIT_PROFILES.find((item) => item.id === progress.profile);

  if (!progress || progress.phase === "loading") return "Loading the page…";

  if (progress.phase === "sweep") return `Sweeping widths · ${progress.width}px`;

  if (progress.phase === "profiles") return profile ? `Checking ${profile.label} · ${profile.width} × ${profile.height}` : `Checking profiles · ${progress.width}px`;

  if (progress.phase === "interactions") return `Checking keyboard focus and menus · ${progress.width}px`;

  return "Building report…";
}

/** Whole-run completion, across the pages of a site audit. */
export function progressPercent(progress: AuditProgress | null): number {
  const site = progress?.site;
  const fraction = progress ? progress.done / Math.max(1, progress.total) : 0;

  return Math.round((site ? (site.index + fraction) / Math.max(1, site.total) : fraction) * 100);
}

const position = (width: number) => `${scopePosition(width) * 100}%`;

/** A 320–1920px ruler (log scale, like the width scope) with the width ranges where a problem was measured. */
export function WidthRuler({ ranges, severity, ticks = false, label }: { ranges: Array<[number, number]>; severity?: AuditFinding["severity"]; ticks?: boolean; label: string }) {
  return <div className="width-ruler" data-severity={severity} role="img" aria-label={label}>
    <div className="width-ruler-track">
      {ranges.map(([from, to]) => <span key={`${from}-${to}`} className="width-ruler-range" style={{ left: position(from), width: `max(3px, calc(${position(to)} - ${position(from)}))` }} />)}
    </div>
    {ticks && <div className="width-ruler-ticks" aria-hidden="true">{TICKS.map((tick) => <span key={tick} style={{ left: position(tick) }}>{tick}</span>)}</div>}
  </div>;
}

function sourceLabel(finding: AuditFinding): string | null {
  const source = finding.element?.source;

  if (!source?.file) return source?.component ?? null;
  const file = source.file.split("/").slice(-2).join("/");

  return `${source.component ? `${source.component} · ` : ""}${file}${source.line ? `:${source.line}` : ""}`;
}

/** seen: the snapshot boards the finding was seen on, in report order; onLocate brings one into view on the canvas. */
function FindingCard({ finding, index, selected, attached, ignored, seen, onSelect, onShow, onFix, onIgnore, onHover, onLocate }: {
  finding: AuditFinding; index: number; selected: boolean; attached: boolean; ignored: boolean; seen: Array<{ id: string; label: string; width: number }>;
  onSelect: () => void; onShow: () => void; onFix: () => void; onIgnore: () => void; onHover: (hovered: boolean) => void; onLocate: (profileId: string) => void;
}) {
  const card = useRef<HTMLElement>(null);
  const source = sourceLabel(finding);
  const [helpError, setHelpError] = useState(false);
  const help = finding.rule?.url;

  useEffect(() => { if (selected) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected]);

  return <article ref={card} className="finding-card" data-severity={finding.severity} data-selected={selected || undefined} data-finding-id={finding.id} aria-label={`Finding ${index}: ${finding.title}`}
    onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onHover(false); }}>
    <button type="button" className="finding-summary" aria-expanded={selected} onClick={onSelect}>
      <span className="finding-index" aria-hidden="true">{index}</span>
      <span className="finding-heading">
        <strong>{finding.title}</strong>
        <span className="finding-meta">
          <span className="finding-severity">{finding.severity}</span>
          {finding.criterion ? <span className="finding-criterion">WCAG {finding.criterion.id} {finding.criterion.name}</span> : <span className="finding-criterion muted">{finding.rule ? "Best practice" : "Responsive layout"}</span>}
        </span>
      </span>
      <span className="finding-aside">
        <ChevronDown className="finding-chevron" size={14} aria-hidden="true" />
        <span className="finding-span" role="img" aria-label={`Measured at ${formatRanges(finding.ranges)}`}>
          {finding.ranges.map(([from, to]) => <span key={`${from}-${to}`} style={{ left: position(from), width: `max(3px, calc(${position(to)} - ${position(from)}))` }} />)}
        </span>
      </span>
    </button>
    {selected && <div className="finding-body">
      <p>{finding.detail}</p>
      <div className="finding-fix"><Compass size={15} aria-hidden="true" /><p><strong>Direction</strong>{finding.fixHint}</p></div>
      {(finding.element || finding.rule) && <div className="finding-facts">
        {finding.element && <p className="finding-element"><code>{finding.element.selector}</code>{source && <span title={finding.element.source?.verified ? "Host-verified source file" : "Unverified hint from the React development build"}>{source}{finding.element.source?.verified && <Check size={12} aria-label="verified" />}</span>}</p>}
        {finding.rule && <span className="finding-rule" title={finding.rule.help}>axe · {finding.rule.id}</span>}
      </div>}
      {seen.length > 0 && <div className="finding-seen" role="group" aria-label="Seen at">
        <span>Seen at</span>
        {seen.map((board) => <button key={board.id} type="button" title={`Show the ${board.label} snapshot on the canvas`} aria-label={`Show on the ${board.label} snapshot`} onClick={() => onLocate(board.id)}>
          <code>{board.width}</code>{profileTag(board.id) && <span>{profileTag(board.id)}</span>}
        </button>)}
      </div>}
      <div className="finding-actions">
        <button type="button" className="finding-fix-action" disabled={attached} onClick={onFix}><Bot size={14} aria-hidden="true" /><span>{attached ? "Attached to chat" : "Fix with agent"}</span></button>
        <button type="button" onClick={onShow}><Eye size={14} aria-hidden="true" /><span>Show at {finding.worst.width}px</span></button>
      </div>
      {(finding.classification !== "bug" || help) && <div className="finding-actions" data-secondary="">
        {finding.classification !== "bug" && <button type="button" className="finding-ignore" onClick={onIgnore}>{ignored ? <Undo2 size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}<span>{ignored ? "Restore" : "Mark intentional"}</span></button>}
        {help && <button type="button" className="finding-help" title="Opens Deque's rule page in your browser" onClick={() => { setHelpError(false); void window.mauxi?.openAxeHelp(help).catch(() => setHelpError(true)); }}><span>Learn more</span><ArrowUpRight size={13} aria-hidden="true" /></button>}
      </div>}
      {helpError && <p className="finding-help-error" role="alert">Could not open your default browser.</p>}
    </div>}
  </article>;
}

/** siteView replaces the report body (site setup or summary); pageBar sits above a site page's report. */
export function AuditPanel({ report, progress, running, error, selected, attached, ignored, onRun, onCancel, onSelect, onShow, onFix, onIgnore, onHover, onLocate, onClose, onSite, siteView, pageBar }: {
  report: AuditReport | null; progress: AuditProgress | null; running: boolean; error: string; selected: string | null;
  attached: ReadonlySet<string>; ignored: ReadonlySet<string>;
  onRun: () => void; onCancel: () => void; onSelect: (finding: AuditFinding) => void; onShow: (finding: AuditFinding) => void;
  onFix: (finding: AuditFinding) => void; onIgnore: (finding: AuditFinding) => void; onClose: () => void;
  /** The finding under the pointer or keyboard focus in the list, or null when it leaves; the canvas spotlights it. */
  onHover: (finding: AuditFinding | null) => void;
  /** Brings the finding's snapshot board for a profile into view on the canvas. */
  onLocate: (finding: AuditFinding, profileId: string) => void;
  onSite: () => void; siteView?: ReactNode; pageBar?: ReactNode;
}) {
  const [showResolved, setShowResolved] = useState(true);
  const [showUnverified, setShowUnverified] = useState(false);
  const [showInteractions, setShowInteractions] = useState(false);
  const [showScrollers, setShowScrollers] = useState(false);
  const visible = report?.findings.filter((finding) => !ignored.has(finding.id)) ?? [];
  const hidden = report?.findings.filter((finding) => ignored.has(finding.id)) ?? [];
  const site = progress?.site;
  const percent = progressPercent(progress);
  const stat = (kind: string, label: string, value: number) => <div data-kind={kind} data-zero={value === 0 || undefined}><dt>{label}</dt><dd>{value}</dd></div>;

  const card = (finding: AuditFinding) => <FindingCard key={finding.id} finding={finding} index={report!.findings.indexOf(finding) + 1} selected={selected === finding.id} attached={attached.has(finding.id)} ignored={ignored.has(finding.id)}
    seen={report!.snapshots.filter((snapshot) => seenOn(finding, snapshot.profileId)).map((snapshot) => ({ id: snapshot.profileId, label: snapshot.label, width: snapshot.width }))}
    onSelect={() => onSelect(finding)} onShow={() => onShow(finding)} onFix={() => onFix(finding)} onIgnore={() => onIgnore(finding)} onHover={(hovered) => onHover(hovered ? finding : null)} onLocate={(profileId) => onLocate(finding, profileId)} />;

  return <aside className="audit-panel" aria-label="Responsive audit">
    <header className="audit-panel-header">
      <div>
        <h2><ScanSearch size={16} aria-hidden="true" />Responsive audit</h2>
        <p title={report ? `Scanned in ${(report.durationMs / 1000).toFixed(1)}s` : undefined}>{report ? <><code>{report.route}</code><span className="audit-panel-scan">{report.profiles.length} viewports · {report.widthsScanned} widths</span></> : siteView ? "Every page, across every width" : "Reflow, zoom and spacing across every width"}</p>
      </div>
      <div className="audit-panel-actions">
        {!running && <button type="button" className="audit-site" onClick={onSite} aria-label="Audit site" title="Audit site: find the pages linked from this route and audit them in a batch"><Layers size={15} aria-hidden="true" /></button>}
        {running
          ? <button type="button" className="audit-run" data-running="" aria-label="Stop audit" title="Stop audit" onClick={onCancel}><Square size={13} aria-hidden="true" /><span>Stop</span></button>
          : <button type="button" className="audit-run" onClick={onRun}>{report ? <RotateCcw size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}<span>{report ? "Re-run" : "Run audit"}</span></button>}
        <button type="button" className="audit-close" aria-label="Hide audit panel" title="Hide audit panel" onClick={onClose}><PanelRightClose size={16} aria-hidden="true" /></button>
      </div>
    </header>

    {running && (progress || !siteView) && <div className="audit-progress" role="status" aria-live="polite">
      <div className="audit-progress-label"><LoaderCircle size={14} className="spin" aria-hidden="true" />
        <span>{site && `Page ${site.index + 1} of ${site.total} · `}{progressText(progress)}</span>
        <span className="audit-progress-count">{percent}%</span>
      </div>
      <div className="audit-progress-bar"><span style={{ width: `${percent}%` }} /></div>
    </div>}

    {error && <p className="audit-error" role="alert">{error}</p>}
    {report?.axe?.note && !running && <p className="audit-note" role="note">{report.axe.note} Layout checks are complete.</p>}

    {siteView}

    {report && pageBar}

    {!report && !running && !siteView && <div className="audit-empty">
      <p>Mauxi sweeps this page from 320 to 1920px in a hidden window and checks it on {AUDIT_PROFILES.length} device profiles. Your previews stay untouched.</p>
      <ul aria-label="Checks">{CHECKS.map((check) => <li key={check}>{check}</li>)}</ul>
      <p className="audit-empty-site"><Layers size={13} aria-hidden="true" />Use <strong>Audit site</strong> to find the pages linked from here and audit them together.</p>
    </div>}

    {report && <div className="audit-overview">
      <dl className="audit-summary">
        {stat("bug", "Bugs", visible.filter((finding) => finding.classification === "bug").length)}
        {stat("review", "Review", visible.filter((finding) => finding.classification === "review").length)}
        {stat("intentional", "Intentional", visible.filter((finding) => finding.classification === "intentional").length)}
        {stat("resolved", "Resolved", report.resolved.length)}
      </dl>
    </div>}

    {report && <div className="audit-findings">
      {report.resolved.length > 0 && <section className="finding-group resolved-group">
        <button type="button" className="finding-group-title" aria-expanded={showResolved} onClick={() => setShowResolved((open) => !open)}><Check size={14} aria-hidden="true" />Resolved since last run<span>{report.resolved.length}</span><ChevronDown className="finding-chevron" size={14} aria-hidden="true" /></button>
        {showResolved && <ul>{report.resolved.map((finding) => <li key={finding.id} data-finding-id={finding.id} onPointerEnter={() => onHover(finding)} onPointerLeave={() => onHover(null)}><Check size={12} aria-hidden="true" /><span>{finding.title}</span></li>)}</ul>}
      </section>}
      {(report.unverified?.length ?? 0) > 0 && <section className="finding-group unverified-group">
        <button type="button" className="finding-group-title" aria-expanded={showUnverified} onClick={() => setShowUnverified((open) => !open)}><RotateCcw size={14} aria-hidden="true" />Not re-checked this run<span>{report.unverified!.length}</span><ChevronDown className="finding-chevron" size={14} aria-hidden="true" /></button>
        {showUnverified && <ul>{report.unverified!.map((finding) => <li key={finding.id}><span>{finding.title}</span></li>)}</ul>}
      </section>}
      {GROUPS.map((group) => {
        const items = visible.filter((finding) => finding.classification === group.id);

        return items.length > 0 && <section key={group.id} className="finding-group" data-group={group.id} aria-label={group.label}>
          <h3 className="finding-group-title" title={group.hint}>{group.label}<span>{items.length}</span></h3>
          {items.map(card)}
        </section>;
      })}
      {!visible.length && <p className="audit-clean"><Check size={16} aria-hidden="true" />No responsive findings at any measured width.</p>}
      {report.interactions && <section className="finding-group interaction-group" aria-label="Interaction checks">
        <button type="button" className="finding-group-title" title="Tab-only focus walk, disclosures and tooltips at narrow profiles" aria-expanded={showInteractions} onClick={() => setShowInteractions((open) => !open)}><Keyboard size={14} aria-hidden="true" />Interaction checks<span>{(report.interactions.durationMs / 1000).toFixed(1)}s</span><ChevronDown className="finding-chevron" size={14} aria-hidden="true" /></button>
        {showInteractions && <p className="interaction-summary">{count(report.interactions.focusStops, "focus stop")} · {count(report.interactions.disclosures, "disclosure")} opened · {count(report.interactions.hovers, "tooltip")} hovered · {report.interactions.profiles.map((id) => report.profiles.find((profile) => profile.id === id)?.label ?? id).join(", ")}</p>}
        {showInteractions && report.interactions.notes.length > 0 && <ul aria-label="Interaction notes">{report.interactions.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </section>}
      {report.scrollers.length > 0 && <section className="finding-group scroller-group" aria-label="Intentional scrollers">
        <button type="button" className="finding-group-title" title="Kept scrolling on purpose" aria-expanded={showScrollers} onClick={() => setShowScrollers((open) => !open)}>Intentional scrollers<span>{report.scrollers.length}</span><ChevronDown className="finding-chevron" size={14} aria-hidden="true" /></button>
        {showScrollers && <ul>{report.scrollers.map((scroller) => <li key={scroller.key}><code>{scroller.element.selector}</code><span>{scroller.signals.join(", ")}</span></li>)}</ul>}
      </section>}
      {hidden.length > 0 && <section className="finding-group" data-group="ignored" aria-label="Marked intentional">
        <h3 className="finding-group-title">Marked intentional<span>{hidden.length}</span></h3>
        {hidden.map(card)}
      </section>}
    </div>}
  </aside>;
}
