import { useRef, type KeyboardEvent } from "react";
import { ChevronsDown, ChevronsUp, LoaderCircle, ScanSearch } from "lucide-react";
import type { Artboard, Camera } from "../application/canvas-state";
import { AUDIT_PROFILES, sweepWidths, type AuditFinding, type AuditProgress, type AuditReport, type AuditSnapshot, type FindingSeverity } from "../application/audit-contract";
import { CAPTION, clusterPins, CROP_FADE, LANE_LABEL, layoutSheet, profileTag, seenOn, type Sheet, type SheetTile } from "../application/audit-layout";
import { progressPercent, progressText } from "./AuditPanel";

/** queued: not measured yet; measuring: being measured now; captured: its snapshot arrived. */
export type BoardState = "queued" | "measuring" | "captured";

interface MatrixItem { id: string; label: string; note?: string; viewport: { width: number; height: number }; snapshot: AuditSnapshot | null; state: BoardState }

export interface MatrixBoard extends SheetTile, MatrixItem {}

/** A single-route run in progress: the snapshots streamed so far and the profile being measured. */
export interface FormingAudit { snapshots: AuditSnapshot[]; current: string | null }

/** sheet: the surface, lane labels and tile placement under the live previews (see audit-layout.ts). */
export interface AuditMatrix { boards: MatrixBoard[]; sheet: Sheet | null }

/** Pins closer than this (screen px) share one label. */
const PIN_RADIUS = 18;

const RANK: Record<FindingSeverity, number> = { serious: 3, moderate: 2, minor: 1 };

/**
 * Lays out one tile per audit profile on the audit sheet below the live previews. While a run forms the matrix, every
 * profile has a viewport-sized tile (a placeholder until its snapshot streams in, then the part above the fold), so the
 * layout holds still for the whole run; a finished report shows its full-page snapshots cropped to the first screen
 * (expanded: tiles shown uncropped), interaction boards included.
 */
export function auditMatrix(report: AuditReport | null, forming: FormingAudit | null, live: Artboard[], expanded: ReadonlySet<string> = new Set()): AuditMatrix {
  const items: MatrixItem[] = forming
    ? AUDIT_PROFILES.map((profile) => {
      const snapshot = forming.snapshots.find((item) => item.profileId === profile.id) ?? null;
      const state = snapshot ? "captured" : forming.current === profile.id ? "measuring" : "queued";

      return { id: profile.id, label: profile.label, note: profile.note, viewport: { width: profile.width, height: profile.height }, snapshot, state };
    })
    : (report?.snapshots ?? []).map((snapshot) => ({ id: snapshot.profileId, label: snapshot.label, note: snapshot.note, viewport: { width: snapshot.width, height: snapshot.height }, snapshot, state: "captured" }));

  const sheet = layoutSheet(items.map((item) => ({ id: item.id, width: item.viewport.width, height: item.viewport.height, content: forming ? item.viewport.height : item.snapshot?.imageHeight ?? item.viewport.height })), live, forming ? new Set() : expanded);

  if (!sheet) return { boards: [], sheet: null };

  return { boards: items.map((item, index) => ({ ...item, ...sheet.tiles[index] })), sheet };
}

/**
 * One cell per width the sweep measured, coloured by the worst finding there; the spotlit finding's widths stay lit. It is
 * also a slider: dragging along it or using the arrow keys resizes a live preview to a measured width (onScrub).
 * value: the width it shows as chosen.
 */
function SweepStrip({ findings, lit, value, locked, onScrub }: {
  findings: AuditFinding[]; lit: AuditFinding | null; value: number; locked: boolean; onScrub: (width: number, phase: "start" | "move" | "end") => void;
}) {
  const widths = sweepWidths();
  const cells = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const covers = (finding: AuditFinding, width: number) => finding.ranges.some(([from, to]) => from <= width && width <= to);
  const marks = [{ label: "320", at: 0 }, { label: "480", at: widths.findIndex((width) => width > 480) }, { label: "1024", at: widths.findIndex((width) => width > 1024) }, { label: "1920", at: widths.length }];
  const clamp = (index: number) => Math.max(0, Math.min(widths.length - 1, index));
  const index = clamp(widths.findIndex((width) => width >= value) === -1 ? widths.length - 1 : widths.findIndex((width) => width >= value));

  const under = (clientX: number) => {
    const rect = cells.current!.getBoundingClientRect();

    return widths[clamp(Math.floor((clientX - rect.left) / rect.width * widths.length))];
  };

  const move = (clientX: number, phase: "start" | "move" | "end") => {
    const width = under(clientX);

    if (phase === "move" && width === drag.current) return;
    drag.current = phase === "end" ? null : width;
    onScrub(width, phase);
  };

  /** The measured width a key moves to: the previous or next one, five at a time with Page keys, or either end. */
  const stepTo = (key: string): number | null => {
    switch (key) {
      case "ArrowLeft": case "ArrowDown": return widths.findLast((width) => width < value) ?? widths[0];
      case "ArrowRight": case "ArrowUp": return widths.find((width) => width > value) ?? widths.at(-1)!;
      case "PageDown": return widths[clamp(index - 5)];
      case "PageUp": return widths[clamp(index + 5)];
      case "Home": return widths[0];
      case "End": return widths.at(-1)!;
      default: return null;
    }
  };

  const keydown = (event: KeyboardEvent) => {
    const width = stepTo(event.key);

    if (width === null) return;
    event.preventDefault();
    onScrub(width, "end");
  };

  return <div className="sweep-strip" data-spotlight={lit ? "" : undefined} role="slider" tabIndex={0} aria-label="Resize a live preview to a measured width"
    aria-valuemin={widths[0]} aria-valuemax={widths.at(-1)} aria-valuenow={value} aria-valuetext={`${value} px, ${value <= 1024 ? "Mobile" : "Desktop"} preview`} aria-disabled={locked || undefined}
    title="Drag to resize the Mobile (up to 1024 px) or Desktop preview to a measured width"
    onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); move(event.clientX, "start"); }}
    onPointerMove={(event) => { if (drag.current !== null) move(event.clientX, "move"); }}
    onPointerUp={(event) => { if (drag.current !== null) move(event.clientX, "end"); }}
    onPointerCancel={() => { if (drag.current !== null) { onScrub(drag.current, "end"); drag.current = null; } }}
    onKeyDown={keydown}>
    <div className="sweep-track" aria-hidden="true">
      <div className="sweep-cells" ref={cells}>
        {widths.map((width) => {
          const worst = findings.filter((finding) => covers(finding, width)).sort((a, b) => RANK[b.severity] - RANK[a.severity])[0];

          return <span key={width} data-severity={worst?.severity} data-lit={lit && covers(lit, width) || undefined} />;
        })}
      </div>
      <span className="sweep-thumb" style={{ left: `${(index + .5) / widths.length * 100}%` }}><span>{value}</span></span>
    </div>
    <div className="sweep-marks" aria-hidden="true">{marks.map(({ label, at }) => <span key={label} style={{ left: `${at / widths.length * 100}%` }}>{label}</span>)}</div>
  </div>;
}

/** The finding numbers a pin label shows for a group: up to three, then the first and how many more. */
function groupLabel(indexes: number[]) {
  return indexes.length <= 3 ? indexes.join("·") : `${indexes[0]} +${indexes.length - 1}`;
}

/**
 * spotlight: the finding hovered or selected in the panel. Tiles where it was seen are lit, the others dim, and on lit
 * tiles its markers stay prominent while the rest fade (they stay real buttons either way). expanded: tiles shown
 * uncropped; onExpand toggles one. peek: the tile peeked at; onPeek peeks at one (a click on its page or caption). scrub:
 * the width the sweep strip shows as chosen; onScrub resizes a live preview (refused while locked).
 */
export function AuditBoards({ matrix, report, forming, progress, camera, selected, spotlight, ignored, expanded, peek, scrub, locked, onSelect, onExpand, onPeek, onScrub }: {
  matrix: AuditMatrix; report: AuditReport | null; forming: boolean; progress: AuditProgress | null; camera: Camera; selected: string | null; spotlight: string | null; ignored: ReadonlySet<string>;
  expanded: ReadonlySet<string>; peek: string | null; scrub: number; locked: boolean;
  onSelect: (finding: AuditFinding) => void; onExpand: (profileId: string) => void; onPeek: (profileId: string) => void; onScrub: (width: number, phase: "start" | "move" | "end") => void;
}) {
  const zoom = camera.zoom;
  const findings = forming || !report ? [] : report.findings;
  const visible = findings.filter((finding) => !ignored.has(finding.id));
  const captured = matrix.boards.filter((board) => board.state === "captured").length;
  const bugs = visible.filter((finding) => finding.classification === "bug").length;
  const percent = progressPercent(progress);
  const lit = visible.find((finding) => finding.id === spotlight) ?? null;
  const sheet = matrix.sheet;
  // Screen position of a canvas y, below the live previews' header band and px more of bands that keep their size.
  const top = (y: number, px: number) => `calc(${camera.y + y * zoom}px + 3rem + ${px}px)`;

  return <>
    {sheet && <div className="audit-sheet" style={{ left: camera.x + sheet.frame.x * zoom, top: top(sheet.frame.y, 0), width: sheet.frame.width * zoom, height: sheet.frame.height * zoom + sheet.frame.inset }}>
      <div className="audit-matrix-title" data-forming={forming || undefined} role={forming ? "status" : undefined} aria-live={forming ? "polite" : undefined}>
        {forming ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ScanSearch size={14} aria-hidden="true" />}
        <strong>{forming ? "Auditing" : "Responsive audit"}</strong>
        {!forming && report && <code>{report.route}</code>}
        <span className="audit-matrix-detail">{forming ? `${progressText(progress)} · ${captured} of ${matrix.boards.length} viewports` : `${report?.profiles.length ?? 0} viewports · ${report?.widthsScanned ?? 0} widths`}</span>
        {forming ? <span className="audit-matrix-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span> : <span className="snapshot-count" data-clean={bugs === 0 || undefined}>{bugs === 0 ? "No bugs" : `${bugs} ${bugs === 1 ? "bug" : "bugs"}`}</span>}
        {forming && <span className="audit-matrix-percent">{percent}%</span>}
      </div>
      <SweepStrip findings={visible} lit={lit} value={scrub} locked={locked} onScrub={onScrub} />
    </div>}
    {sheet?.lanes.map((lane) => lane.label && <div key={lane.id} className="sheet-lane-label" data-lane={lane.id} aria-hidden="true"
      style={{ left: camera.x + lane.x * zoom, top: top(lane.y, lane.inset - CAPTION - LANE_LABEL), width: lane.width * zoom, height: LANE_LABEL }}>{lane.label}</div>)}
    {matrix.boards.map(({ id, label, note, viewport, snapshot, state, x, y, width, height, scale, cropped, inset }) => {
      const markers = visible.flatMap((finding) => finding.markers.filter((marker) => marker.profileId === id).map((marker) => ({ finding, marker, index: findings.indexOf(finding) + 1 })));
      const issues = new Set(markers.map((item) => item.finding.id)).size + visible.filter((finding) => !finding.markers.length && finding.profiles.includes(id)).length;
      const status = state === "queued" ? "Queued" : state === "measuring" ? "Measuring" : "Captured";
      const imageHeight = snapshot?.imageHeight ?? viewport.height;
      // Markers that start in the crop's fade or under it count as hidden, as when the panel locates a finding.
      const below = cropped ? markers.filter(({ marker }) => Math.max(0, marker.rect.y) * scale >= height - CROP_FADE).length : 0;
      const open = expanded.has(id) && !forming;

      // Pins that would overlap share the first one's label; the spotlit finding and pins below the crop keep their own.
      const pins = markers.map(({ marker }) => ({ x: Math.max(0, marker.rect.x) * scale * zoom, y: Math.max(0, marker.rect.y) * scale * zoom }));
      const free = markers.map((item, at) => at).filter((at) => markers[at].finding.id !== lit?.id && pins[at].y < height * zoom);
      const labels = new Map<number, string>();
      const hidden = new Set<number>();

      for (const group of clusterPins(free.map((at) => pins[at]), PIN_RADIUS).filter((members) => members.length > 1).map((members) => members.map((member) => free[member]))) {
        labels.set(group[0], groupLabel(group.map((at) => markers[at].index)));
        group.slice(1).forEach((at) => hidden.add(at));
      }

      const caption = <>
        <strong><code className="snapshot-width">{viewport.width}</code>{profileTag(id) && <span className="snapshot-tag">{profileTag(id)}</span>}<span className="snapshot-name">{label}</span></strong>
        <span className="snapshot-detail">× {viewport.height}{note ? ` · ${note}` : ""}</span>
      </>;

      return <section key={id} className="artboard snapshot-board" data-profile-id={id} data-state={forming ? state : undefined} data-spotlight={lit ? seenOn(lit, id) ? "lit" : "dimmed" : undefined} data-cropped={cropped || undefined} data-peek={peek === id || undefined} aria-busy={forming && state !== "captured" || undefined}
        aria-label={forming ? `${label} viewport, ${status.toLowerCase()}` : `${label} snapshot, ${issues} findings`}
        style={{ left: camera.x + x * zoom, top: top(y, inset - CAPTION), width: width * zoom }}>
        <header className="artboard-header snapshot-header" style={{ height: CAPTION }}>
          {forming
            ? <div className="snapshot-title" title={`${label} · ${viewport.width} × ${viewport.height}${note ? ` · ${note}` : ""}`}>{caption}</div>
            : <button type="button" className="snapshot-title" title={`Peek at ${label} · ${viewport.width} × ${viewport.height}${note ? ` · ${note}` : ""}`} aria-label={`Peek at the ${label} snapshot`} onClick={() => onPeek(id)}>{caption}</button>}
          {forming
            ? <span className="snapshot-state" data-state={state}>{state === "measuring" && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{status}</span>
            : <span className="snapshot-count" data-clean={issues === 0 || undefined}>{issues === 0 ? "Clean" : <>{issues}<span className="snapshot-count-unit"> {issues === 1 ? "issue" : "issues"}</span></>}</span>}
        </header>
        <div className="snapshot-surface" style={{ width: width * zoom, height: height * zoom }} onClick={forming ? undefined : () => onPeek(id)}>
          {snapshot
            ? <img src={snapshot.image} alt={`${label} at ${viewport.width} by ${viewport.height}`} draggable={false} style={{ width: width * zoom, height: snapshot.imageHeight * scale * zoom }} />
            : <div className="snapshot-placeholder" aria-hidden="true"><span>{viewport.width} × {viewport.height}</span></div>}
          {snapshot && snapshot.imageHeight > snapshot.height && snapshot.height * scale < height && <div className="snapshot-fold" style={{ top: snapshot.height * scale * zoom }} aria-hidden="true"><span>Viewport fold</span></div>}
          {markers.map(({ finding, marker, index }, at) => {
            const left = Math.max(0, marker.rect.x) * scale * zoom;
            const markerTop = Math.max(0, marker.rect.y) * scale * zoom;
            const boxWidth = Math.max(8, Math.min(marker.rect.width, viewport.width - Math.max(0, marker.rect.x) + 40) * scale * zoom);
            const boxHeight = Math.max(8, Math.min(marker.rect.height, imageHeight - Math.max(0, marker.rect.y)) * scale * zoom);

            return <button key={`${finding.id}-${id}`} type="button" className="finding-marker" data-severity={finding.severity} data-classification={finding.classification} data-selected={selected === finding.id || undefined} data-spotlit={lit?.id === finding.id || undefined}
              data-grouped={hidden.has(at) || undefined} data-group={labels.has(at) || undefined}
              aria-label={`Finding ${index}: ${finding.title}`} title={`${index}. ${finding.title}`} style={{ left, top: markerTop, width: boxWidth, height: boxHeight }} onClick={(event) => { event.stopPropagation(); onSelect(finding); }}>
              <span>{labels.get(at) ?? index}</span>
            </button>;
          })}
          {markers.length > 0 && <div className="snapshot-rail" aria-hidden="true">
            {markers.map(({ finding, marker }) => <span key={finding.id} data-severity={finding.severity} data-spotlit={lit?.id === finding.id || undefined} style={{ top: `${Math.min(100, Math.max(0, marker.rect.y) / imageHeight * 100)}%` }} />)}
          </div>}
          {(cropped || open) && <div className="snapshot-crop" data-open={open || undefined}>
            <button type="button" aria-expanded={open} aria-label={open ? `Crop ${label} to the first screen` : `Show the full ${label} page${below ? `, ${below} more ${below === 1 ? "marker" : "markers"} below` : ""}`} onClick={(event) => { event.stopPropagation(); onExpand(id); }}>
              {open ? <ChevronsUp size={12} aria-hidden="true" /> : <ChevronsDown size={12} aria-hidden="true" />}
              <span>{open ? "Crop" : below ? `${below} more below` : "Full page"}</span>
            </button>
          </div>}
        </div>
      </section>;
    })}
  </>;
}
