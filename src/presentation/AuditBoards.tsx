import { LoaderCircle, ScanSearch } from "lucide-react";
import type { Artboard, Camera, Point } from "../application/canvas-state";
import { AUDIT_PROFILES, type AuditFinding, type AuditProgress, type AuditReport, type AuditSnapshot } from "../application/audit-contract";
import { progressPercent, progressText } from "./AuditPanel";

/** queued: not measured yet; measuring: being measured now; captured: its snapshot arrived. */
export type BoardState = "queued" | "measuring" | "captured";

interface MatrixItem { id: string; label: string; note?: string; viewport: { width: number; height: number }; snapshot: AuditSnapshot | null; state: BoardState }

export interface MatrixBoard extends Artboard, MatrixItem { stack: number }

/** A single-route run in progress: the snapshots streamed so far and the profile being measured. */
export interface FormingAudit { snapshots: AuditSnapshot[]; current: string | null }

/** title: where the matrix heading sits, one header band above the first row. */
export interface AuditMatrix { boards: MatrixBoard[]; title: Point | null }

const ROW_GAP = 220;
const BOARD_GAP = 96;

/** Rows are packed to fit a landscape canvas of this aspect ratio best. */
const ASPECT = 1.5;

/** Wraps boards in order into rows no wider than limit. */
function wrap(widths: number[], limit: number): number[][] {
  const rows: number[][] = [];
  let width = Infinity;

  widths.forEach((board, index) => {
    if (width + BOARD_GAP + board > limit) { rows.push([index]); width = board; } else { rows.at(-1)!.push(index); width += BOARD_GAP + board; }
  });

  return rows;
}

/** Tries every row width the boards can wrap at and keeps the rows that let the camera fit the live previews and the matrix largest; on a tie, the narrowest, most even rows. */
function pack(sizes: Array<{ width: number; height: number }>, span: number, liveHeight: number): number[][] {
  const limits = new Set<number>();

  for (let start = 0; start < sizes.length; start++) {
    for (let end = start, width = -BOARD_GAP; end < sizes.length; end++) { width += BOARD_GAP + sizes[end].width; limits.add(width); }
  }

  let best = { rows: sizes.map((_size, index) => [index]), scale: 0 };

  for (const limit of [...limits].sort((a, b) => a - b)) {
    const rows = wrap(sizes.map((size) => size.width), limit);
    const width = Math.max(span, ...rows.map((row) => row.reduce((sum, index) => sum + sizes[index].width, (row.length - 1) * BOARD_GAP)));
    const height = rows.reduce((sum, row) => sum + ROW_GAP + Math.max(...row.map((index) => sizes[index].height)), liveHeight);
    const scale = Math.min(ASPECT / width, 1 / height);

    if (scale > best.scale * 1.000001) best = { rows, scale };
  }

  return best.rows;
}

/**
 * Lays out one board per audit profile below the live previews, in canvas coordinates. While a run forms the matrix, every
 * profile has a viewport-sized board (a placeholder until its snapshot streams in, then the part above the fold), so the
 * layout holds still for the whole run; a finished report packs its full-page snapshots, interaction boards included.
 */
export function auditMatrix(report: AuditReport | null, forming: FormingAudit | null, live: Artboard[]): AuditMatrix {
  const items: MatrixItem[] = forming
    ? AUDIT_PROFILES.map((profile) => {
      const snapshot = forming.snapshots.find((item) => item.profileId === profile.id) ?? null;
      const state = snapshot ? "captured" : forming.current === profile.id ? "measuring" : "queued";

      return { id: profile.id, label: profile.label, note: profile.note, viewport: { width: profile.width, height: profile.height }, snapshot, state };
    })
    : (report?.snapshots ?? []).map((snapshot) => ({ id: snapshot.profileId, label: snapshot.label, note: snapshot.note, viewport: { width: snapshot.width, height: snapshot.height }, snapshot, state: "captured" }));

  if (!items.length || !live.length) return { boards: [], title: null };
  const left = Math.min(...live.map((board) => board.x));
  const top = Math.min(...live.map((board) => board.y));
  const bottom = Math.max(...live.map((board) => board.y + board.height));
  const span = Math.max(...live.map((board) => board.x + board.width)) - left;
  const height = (item: MatrixItem) => forming ? item.viewport.height : item.snapshot?.imageHeight ?? item.viewport.height;
  const rows = pack(items.map((item) => ({ width: item.viewport.width, height: height(item) })), span, bottom - top);
  let y = bottom + ROW_GAP;

  // Row n sits below the live previews' headers, the matrix title and its own header: n + 2 bands that do not scale.
  const boards = rows.flatMap((row, index) => {
    let x = left;

    const placed = row.map((at) => {
      const item = items[at];
      const board: MatrixBoard = { ...item, x, y, width: item.viewport.width, height: height(item), stack: index + 2 };
      x += item.viewport.width + BOARD_GAP;

      return board;
    });

    y += Math.max(...placed.map((board) => board.height)) + ROW_GAP;

    return placed;
  });

  return { boards, title: { x: left, y: bottom + ROW_GAP } };
}

export function AuditBoards({ matrix, report, forming, progress, camera, selected, ignored, onSelect }: {
  matrix: AuditMatrix; report: AuditReport | null; forming: boolean; progress: AuditProgress | null; camera: Camera; selected: string | null; ignored: ReadonlySet<string>;
  onSelect: (finding: AuditFinding) => void;
}) {
  const zoom = camera.zoom;
  const findings = forming || !report ? [] : report.findings;
  const visible = findings.filter((finding) => !ignored.has(finding.id));
  const captured = matrix.boards.filter((board) => board.state === "captured").length;
  const bugs = visible.filter((finding) => finding.classification === "bug").length;
  const percent = progressPercent(progress);

  return <>
    {matrix.title && <div className="audit-matrix-title" data-forming={forming || undefined} role={forming ? "status" : undefined} aria-live={forming ? "polite" : undefined}
      style={{ left: camera.x + matrix.title.x * zoom, top: `calc(${camera.y + matrix.title.y * zoom}px + 3rem)` }}>
      {forming ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ScanSearch size={14} aria-hidden="true" />}
      <strong>{forming ? "Auditing" : "Responsive audit"}</strong>
      {!forming && report && <code>{report.route}</code>}
      <span className="audit-matrix-detail">{forming ? `${progressText(progress)} · ${captured} of ${matrix.boards.length} viewports` : `${report?.profiles.length ?? 0} viewports · ${report?.widthsScanned ?? 0} widths`}</span>
      {forming ? <span className="audit-matrix-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span> : <span className="snapshot-count" data-clean={bugs === 0 || undefined}>{bugs === 0 ? "No bugs" : `${bugs} ${bugs === 1 ? "bug" : "bugs"}`}</span>}
      {forming && <span className="audit-matrix-percent">{percent}%</span>}
    </div>}
    {matrix.boards.map(({ id, label, note, viewport, snapshot, state, x, y, width, height, stack }) => {
      const markers = visible.flatMap((finding) => finding.markers.filter((marker) => marker.profileId === id).map((marker) => ({ finding, marker, index: findings.indexOf(finding) + 1 })));
      const issues = new Set(markers.map((item) => item.finding.id)).size + visible.filter((finding) => !finding.markers.length && finding.profiles.includes(id)).length;
      const status = state === "queued" ? "Queued" : state === "measuring" ? "Measuring" : "Captured";

      return <section key={id} className="artboard snapshot-board" data-profile-id={id} data-state={forming ? state : undefined} aria-busy={forming && state !== "captured" || undefined}
        aria-label={forming ? `${label} viewport, ${status.toLowerCase()}` : `${label} snapshot, ${issues} findings`}
        style={{ left: camera.x + x * zoom, top: `calc(${camera.y + y * zoom}px + ${stack * 3}rem)`, width: width * zoom }}>
        <header className="artboard-header snapshot-header">
          <div className="snapshot-title">
            <strong>{label}</strong>
            <span>{viewport.width} × {viewport.height}{note ? ` · ${note}` : ""}</span>
          </div>
          {forming
            ? <span className="snapshot-state" data-state={state}>{state === "measuring" && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{status}</span>
            : <span className="snapshot-count" data-clean={issues === 0 || undefined}>{issues === 0 ? "Clean" : <>{issues}<span className="snapshot-count-unit"> {issues === 1 ? "issue" : "issues"}</span></>}</span>}
        </header>
        <div className="snapshot-surface" style={{ width: width * zoom, height: height * zoom }}>
          {snapshot
            ? <img src={snapshot.image} alt={`${label} at ${viewport.width} by ${viewport.height}`} draggable={false} style={{ width: width * zoom, height: snapshot.imageHeight * zoom }} />
            : <div className="snapshot-placeholder" aria-hidden="true"><span>{viewport.width} × {viewport.height}</span></div>}
          {snapshot && height > snapshot.height && <div className="snapshot-fold" style={{ top: snapshot.height * zoom }} aria-hidden="true"><span>Viewport fold</span></div>}
          {markers.map(({ finding, marker, index }) => {
            const left = Math.max(0, marker.rect.x) * zoom;
            const top = Math.max(0, marker.rect.y) * zoom;
            const boxWidth = Math.max(8, Math.min(marker.rect.width, width - Math.max(0, marker.rect.x) + 40)) * zoom;
            const boxHeight = Math.max(8, Math.min(marker.rect.height, height - Math.max(0, marker.rect.y))) * zoom;

            return <button key={`${finding.id}-${id}`} type="button" className="finding-marker" data-severity={finding.severity} data-classification={finding.classification} data-selected={selected === finding.id || undefined}
              aria-label={`Finding ${index}: ${finding.title}`} title={`${index}. ${finding.title}`} style={{ left, top, width: boxWidth, height: boxHeight }} onClick={(event) => { event.stopPropagation(); onSelect(finding); }}>
              <span>{index}</span>
            </button>;
          })}
        </div>
      </section>;
    })}
  </>;
}
