import { useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Eye, EyeOff, Keyboard, LoaderCircle, PanelRightClose, Play, RotateCcw, ScanSearch, Square, Undo2 } from "lucide-react";
import { formatRanges, type AuditFinding, type AuditProgress, type AuditReport, type FindingClassification } from "../application/audit-contract";

const MIN_WIDTH = 320;
const MAX_WIDTH = 1920;
const TICKS = [320, 768, 1280, 1920];

const GROUPS: Array<{ id: FindingClassification; label: string; hint: string }> = [
  { id: "bug", label: "Bugs", hint: "Measured failures to fix" },
  { id: "review", label: "Needs review", hint: "Probably accidental; you decide" },
  { id: "intentional", label: "Intentional, with gaps", hint: "Deliberate patterns missing accessibility" },
];

const CHECKS = ["1.4.10 Reflow", "1.4.12 Text spacing", "2.5.8 Target size", "2.4.11 Focus not obscured", "2.4.7 Focus visible", "1.4.13 Hover content", "1.4.4 Zoom", "2.1.1 Scroller keyboard access"];

/** Union of possibly overlapping inclusive ranges, for the panel-wide ruler. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];

  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];

    if (last && from <= last[1] + 16) last[1] = Math.max(last[1], to); else merged.push([from, to]);
  }

  return merged;
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;

const position = (width: number) => `${((Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH)) * 100}%`;

/** A 320–1920px ruler with the width ranges where a problem was measured. */
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

function FindingCard({ finding, index, selected, attached, ignored, onSelect, onShow, onFix, onIgnore }: {
  finding: AuditFinding; index: number; selected: boolean; attached: boolean; ignored: boolean;
  onSelect: () => void; onShow: () => void; onFix: () => void; onIgnore: () => void;
}) {
  const card = useRef<HTMLElement>(null);
  const source = sourceLabel(finding);

  useEffect(() => { if (selected) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected]);

  return <article ref={card} className="finding-card" data-severity={finding.severity} data-selected={selected || undefined} data-finding-id={finding.id} aria-label={`Finding ${index}: ${finding.title}`}>
    <button type="button" className="finding-summary" aria-expanded={selected} onClick={onSelect}>
      <span className="finding-index" aria-hidden="true">{index}</span>
      <span className="finding-heading">
        <strong>{finding.title}</strong>
        <span className="finding-meta">
          {finding.criterion ? <span className="finding-criterion">WCAG {finding.criterion.id} {finding.criterion.name}</span> : <span className="finding-criterion muted">Responsive layout</span>}
          <span className="finding-severity">{finding.severity}</span>
        </span>
      </span>
      <ChevronDown className="finding-chevron" size={14} aria-hidden="true" />
    </button>
    <WidthRuler ranges={finding.ranges} severity={finding.severity} label={`Measured at ${formatRanges(finding.ranges)}`} />
    {selected && <div className="finding-body">
      {finding.element && <p className="finding-element"><code>{finding.element.selector}</code>{source && <span title={finding.element.source?.verified ? "Host-verified source file" : "Unverified hint from the React development build"}>{source}{finding.element.source?.verified && <Check size={12} aria-label="verified" />}</span>}</p>}
      <p>{finding.detail}</p>
      <p className="finding-fix"><strong>Direction:</strong> {finding.fixHint}</p>
      <div className="finding-actions">
        <button type="button" onClick={onShow}><Eye size={14} aria-hidden="true" /><span>Show at {finding.worst.width}px</span></button>
        <button type="button" className="finding-fix-action" disabled={attached} onClick={onFix}><Bot size={14} aria-hidden="true" /><span>{attached ? "Attached to chat" : "Fix with agent"}</span></button>
        {finding.classification !== "bug" && <button type="button" className="finding-ignore" onClick={onIgnore}>{ignored ? <Undo2 size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}<span>{ignored ? "Restore" : "Mark intentional"}</span></button>}
      </div>
    </div>}
  </article>;
}

export function AuditPanel({ report, progress, running, error, selected, attached, ignored, onRun, onCancel, onSelect, onShow, onFix, onIgnore, onClose }: {
  report: AuditReport | null; progress: AuditProgress | null; running: boolean; error: string; selected: string | null;
  attached: ReadonlySet<string>; ignored: ReadonlySet<string>;
  onRun: () => void; onCancel: () => void; onSelect: (finding: AuditFinding) => void; onShow: (finding: AuditFinding) => void;
  onFix: (finding: AuditFinding) => void; onIgnore: (finding: AuditFinding) => void; onClose: () => void;
}) {
  const [showResolved, setShowResolved] = useState(true);
  const visible = report?.findings.filter((finding) => !ignored.has(finding.id)) ?? [];
  const hidden = report?.findings.filter((finding) => ignored.has(finding.id)) ?? [];
  const failing = mergeRanges(visible.filter((finding) => finding.classification === "bug").flatMap((finding) => finding.ranges));
  const percent = progress ? Math.round(progress.done / Math.max(1, progress.total) * 100) : 0;

  const card = (finding: AuditFinding) => <FindingCard key={finding.id} finding={finding} index={report!.findings.indexOf(finding) + 1} selected={selected === finding.id} attached={attached.has(finding.id)} ignored={ignored.has(finding.id)}
    onSelect={() => onSelect(finding)} onShow={() => onShow(finding)} onFix={() => onFix(finding)} onIgnore={() => onIgnore(finding)} />;

  return <aside className="audit-panel" aria-label="Responsive audit">
    <header className="audit-panel-header">
      <div>
        <h2><ScanSearch size={16} aria-hidden="true" />Responsive audit</h2>
        <p>{report ? <><code>{report.route}</code> · {report.widthsScanned} widths · {(report.durationMs / 1000).toFixed(1)}s</> : "Reflow, zoom and spacing across every width"}</p>
      </div>
      <div className="audit-panel-actions">
        {running
          ? <button type="button" className="audit-run" data-running="" onClick={onCancel}><Square size={13} aria-hidden="true" /><span>Stop</span></button>
          : <button type="button" className="audit-run" onClick={onRun}>{report ? <RotateCcw size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}<span>{report ? "Re-run" : "Run audit"}</span></button>}
        <button type="button" className="audit-close" aria-label="Hide audit panel" title="Hide audit panel" onClick={onClose}><PanelRightClose size={16} aria-hidden="true" /></button>
      </div>
    </header>

    {running && <div className="audit-progress" role="status" aria-live="polite">
      <div className="audit-progress-label"><LoaderCircle size={14} className="spin" aria-hidden="true" />
        <span>{progress?.phase === "loading" || !progress ? "Loading the page…" : progress.phase === "sweep" ? `Sweeping widths · ${progress.width}px` : progress.phase === "profiles" ? `Checking profiles · ${progress.width}px` : progress.phase === "interactions" ? `Checking keyboard focus and menus · ${progress.width}px` : "Building report…"}</span>
        <span className="audit-progress-count">{percent}%</span>
      </div>
      <div className="audit-progress-bar"><span style={{ width: `${percent}%` }} /></div>
    </div>}

    {error && <p className="audit-error" role="alert">{error}</p>}

    {!report && !running && <div className="audit-empty">
      <p>Mauxi loads this page in a hidden window, sweeps it from 320 to 1920px, then checks phone, tablet, laptop, desktop, 400% zoom and text-spacing profiles, then tabs through the page and opens its menus at 320px. The visible previews stay untouched.</p>
      <ul aria-label="Checks">{CHECKS.map((check) => <li key={check}>{check}</li>)}</ul>
    </div>}

    {report && <div className="audit-overview">
      <WidthRuler ranges={failing} severity="serious" ticks label={failing.length ? `Bugs measured at ${formatRanges(failing)}` : "No bugs measured at any width"} />
      <dl className="audit-summary">
        <div data-kind="bug"><dt>Bugs</dt><dd>{visible.filter((finding) => finding.classification === "bug").length}</dd></div>
        <div data-kind="review"><dt>Review</dt><dd>{visible.filter((finding) => finding.classification === "review").length}</dd></div>
        <div data-kind="intentional"><dt>Intentional</dt><dd>{visible.filter((finding) => finding.classification === "intentional").length}</dd></div>
        <div data-kind="resolved"><dt>Resolved</dt><dd>{report.resolved.length}</dd></div>
      </dl>
    </div>}

    {report && <div className="audit-findings">
      {report.resolved.length > 0 && <section className="finding-group resolved-group">
        <button type="button" className="finding-group-title" aria-expanded={showResolved} onClick={() => setShowResolved((open) => !open)}><Check size={14} aria-hidden="true" />Resolved since last run<span>{report.resolved.length}</span></button>
        {showResolved && <ul>{report.resolved.map((finding) => <li key={finding.id}><Check size={12} aria-hidden="true" /><span>{finding.title}</span></li>)}</ul>}
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
        <h3 className="finding-group-title" title="Tab-only focus walk, disclosures and tooltips at narrow profiles"><Keyboard size={14} aria-hidden="true" />Interaction checks<span>{(report.interactions.durationMs / 1000).toFixed(1)}s</span></h3>
        <p className="interaction-summary">{count(report.interactions.focusStops, "focus stop")} · {count(report.interactions.disclosures, "disclosure")} opened · {count(report.interactions.hovers, "tooltip")} hovered · {report.interactions.profiles.map((id) => report.profiles.find((profile) => profile.id === id)?.label ?? id).join(", ")}</p>
        {report.interactions.notes.length > 0 && <ul aria-label="Interaction notes">{report.interactions.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </section>}
      {report.scrollers.length > 0 && <section className="finding-group scroller-group" aria-label="Intentional scrollers">
        <h3 className="finding-group-title" title="Kept scrolling on purpose">Intentional scrollers<span>{report.scrollers.length}</span></h3>
        <ul>{report.scrollers.map((scroller) => <li key={scroller.key}><code>{scroller.element.selector}</code><span>{scroller.signals.join(", ")}</span></li>)}</ul>
      </section>}
      {hidden.length > 0 && <section className="finding-group" data-group="ignored" aria-label="Marked intentional">
        <h3 className="finding-group-title">Marked intentional<span>{hidden.length}</span></h3>
        {hidden.map(card)}
      </section>}
    </div>}
  </aside>;
}
