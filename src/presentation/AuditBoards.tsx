import type { ReactNode } from "react";
import { ArrowLeft, Check, ChevronsDown, ChevronsUp, Eye, LoaderCircle } from "lucide-react";
import type { Artboard, Camera } from "../application/canvas-state";
import { AUDIT_PROFILES, type AuditFinding, type AuditReport, type AuditSnapshot } from "../application/audit-contract";
import { CAPTION, clusterPins, CROP_FADE, GRID_HEAD, LANE_LABEL, layoutSheet, layoutStage, PAD, profileTag, seenOn, SHEET_HEAD, STAGE_HEAD, type Sheet, type SheetTile, type Stage } from "../application/audit-layout";

/** queued: not measured yet; measuring: being measured now; captured: its snapshot arrived. */
export type BoardState = "queued" | "measuring" | "captured";

interface MatrixItem { id: string; label: string; note?: string; viewport: { width: number; height: number }; snapshot: AuditSnapshot | null; state: BoardState }

/** key: what expanding, cropping and peeking call the tile: its profile id on the sheet or grid, "stage:" + id on the stage. */
export interface MatrixBoard extends SheetTile, MatrixItem { key: string }

/** A single-route run in progress: the snapshots streamed so far and the profile being measured. */
export interface FormingAudit { snapshots: AuditSnapshot[]; current: string | null }

/**
 * sheet: the surface, lane labels and tile placement under the live previews (see audit-layout.ts); in stage mode, the
 * grid beside them. stage: the focused finding's snapshots, large, below (null outside stage mode).
 */
export interface AuditMatrix { boards: MatrixBoard[]; sheet: Sheet | null; stage: (Omit<Stage, "tiles"> & { boards: MatrixBoard[] }) | null }

/** Pins closer than this (screen px) share one label. */
const PIN_RADIUS = 18;

/**
 * Lays out one tile per audit profile on the audit sheet below the live previews. While a run forms the matrix, every
 * profile has a viewport-sized tile (a placeholder until its snapshot streams in, then the part above the fold), so the
 * layout holds still for the whole run; a finished report shows its full-page snapshots cropped to the first screen
 * (expanded: keys of tiles shown uncropped), interaction boards included. focus: in a finished report, the profiles a
 * selected finding was seen on; the matrix is then in stage mode (see layoutStage).
 */
export function auditMatrix(report: AuditReport | null, forming: FormingAudit | null, live: Artboard[], expanded: ReadonlySet<string> = new Set(), focus: string[] | null = null): AuditMatrix {
  const items: MatrixItem[] = forming
    ? AUDIT_PROFILES.map((profile) => {
      const snapshot = forming.snapshots.find((item) => item.profileId === profile.id) ?? null;
      const state = snapshot ? "captured" : forming.current === profile.id ? "measuring" : "queued";

      return { id: profile.id, label: profile.label, note: profile.note, viewport: { width: profile.width, height: profile.height }, snapshot, state };
    })
    : (report?.snapshots ?? []).map((snapshot) => ({ id: snapshot.profileId, label: snapshot.label, note: snapshot.note, viewport: { width: snapshot.width, height: snapshot.height }, snapshot, state: "captured" }));

  const sheetItems = items.map((item) => ({ id: item.id, width: item.viewport.width, height: item.viewport.height, content: forming ? item.viewport.height : item.snapshot?.imageHeight ?? item.viewport.height }));

  if (focus && !forming) {
    const layout = layoutStage(sheetItems, live, focus, expanded);

    if (!layout) return { boards: [], sheet: null, stage: null };
    const stageBoards = layout.stage.tiles.map((tile) => ({ ...items.find((item) => item.id === tile.id)!, ...tile, key: `stage:${tile.id}` }));

    return { boards: items.map((item, index) => ({ ...item, ...layout.grid.tiles[index], key: item.id })), sheet: layout.grid, stage: { frame: layout.stage.frame, boards: stageBoards } };
  }

  const sheet = layoutSheet(sheetItems, live, forming ? new Set() : expanded);

  if (!sheet) return { boards: [], sheet: null, stage: null };

  return { boards: items.map((item, index) => ({ ...item, ...sheet.tiles[index], key: item.id })), sheet, stage: null };
}

/** A tile by the key expanding, cropping and peeking use, on the sheet, the grid or the stage. */
export function matrixTile(matrix: AuditMatrix, key: string): MatrixBoard | undefined {
  return matrix.boards.find((board) => board.key === key) ?? matrix.stage?.boards.find((board) => board.key === key);
}

/** The finding numbers a pin label shows for a group: up to three, then the first and how many more. */
function groupLabel(indexes: number[]) {
  return indexes.length <= 3 ? indexes.join("·") : `${indexes[0]} +${indexes.length - 1}`;
}

/**
 * spotlight: the finding hovered or selected in the panel. Tiles where it was seen are lit, the others dim, and on lit
 * tiles its markers stay prominent while the rest fade (they stay real buttons either way). expanded: keys of tiles shown
 * uncropped; onExpand toggles one. peek: the key of the tile peeked at; onPeek peeks at one (a click on its page or
 * caption). Findings resolved since the last run stay on their tiles as dashed ghosts. In stage mode the stage header
 * names the selected finding and offers Show at (onShow), Full pages (onExpandStage) and All snapshots (onUnstage).
 */
export function AuditBoards({ matrix, report, forming, camera, selected, spotlight, ignored, expanded, peek, onSelect, onExpand, onPeek, onShow, onExpandStage, onUnstage }: {
  matrix: AuditMatrix; report: AuditReport | null; forming: boolean; camera: Camera; selected: string | null; spotlight: string | null; ignored: ReadonlySet<string>;
  expanded: ReadonlySet<string>; peek: string | null;
  onSelect: (finding: AuditFinding) => void; onExpand: (key: string) => void; onPeek: (key: string) => void;
  onShow: (finding: AuditFinding) => void; onExpandStage: (open: boolean) => void; onUnstage: () => void;
}) {
  const zoom = camera.zoom;
  const findings = forming || !report ? [] : report.findings;
  const visible = findings.filter((finding) => !ignored.has(finding.id));
  const resolved = forming || !report ? [] : report.resolved;
  const lit = visible.find((finding) => finding.id === spotlight) ?? resolved.find((finding) => finding.id === spotlight) ?? null;
  const sheet = matrix.sheet;
  const stage = matrix.stage;
  const staged = stage ? findings.find((finding) => finding.id === selected) ?? null : null;
  const stageOpen = !!stage?.boards.length && stage.boards.every((board) => !board.cropped || expanded.has(board.key));
  // Screen position of a canvas y, below the live previews' header band and px more of bands that keep their size.
  const top = (y: number, px: number) => `calc(${camera.y + y * zoom}px + 3rem + ${px}px)`;

  /** One snapshot tile; on the stage it is larger, and the staged finding's markers lead while the others fade. order: its place in the entrance stagger. */
  const tile = ({ key, id, label, note, viewport, snapshot, state, x, y, width, height, scale, cropped, inset }: MatrixBoard, onStage: boolean, order: number): ReactNode => {
    const markers = visible.flatMap((finding) => finding.markers.filter((marker) => marker.profileId === id).map((marker) => ({ finding, marker, index: findings.indexOf(finding) + 1 })));
    const issues = new Set(markers.map((item) => item.finding.id)).size + visible.filter((finding) => !finding.markers.length && finding.profiles.includes(id)).length;
    const status = state === "queued" ? "Queued" : state === "measuring" ? "Measuring" : "Captured";
    const imageHeight = snapshot?.imageHeight ?? viewport.height;
    // Markers that start in the crop's fade or under it count as hidden, as when the panel locates a finding.
    const below = cropped ? markers.filter(({ marker }) => Math.max(0, marker.rect.y) * scale >= height - CROP_FADE).length : 0;
    const open = expanded.has(key) && !forming;
    const ghosts = resolved.flatMap((finding) => finding.markers.filter((marker) => marker.profileId === id).map((marker) => ({ finding, marker })));

    const box = (rect: { x: number; y: number; width: number; height: number }) => ({
      left: Math.max(0, rect.x) * scale * zoom, top: Math.max(0, rect.y) * scale * zoom,
      width: Math.max(8, Math.min(rect.width, viewport.width - Math.max(0, rect.x) + 40) * scale * zoom), height: Math.max(8, Math.min(rect.height, imageHeight - Math.max(0, rect.y)) * scale * zoom),
    });

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

    return <section key={key} className={`artboard ${onStage ? "stage-tile" : "snapshot-board"}`} data-profile-id={id} data-state={forming ? state : undefined}
      data-spotlight={!onStage && lit ? seenOn(lit, id) ? "lit" : "dimmed" : undefined} data-cropped={cropped || undefined} data-peek={peek === key || undefined} data-resolved={ghosts.length || undefined} aria-busy={forming && state !== "captured" || undefined}
      aria-label={forming ? `${label} viewport, ${status.toLowerCase()}` : onStage ? `${label} on the stage, ${issues} findings` : `${label} snapshot, ${issues} findings`}
      style={{ left: camera.x + x * zoom, top: top(y, inset - CAPTION), width: width * zoom, "--i": order }}>
      <header className="artboard-header snapshot-header" style={{ height: CAPTION }}>
        {forming
          ? <div className="snapshot-title" title={`${label} · ${viewport.width} × ${viewport.height}${note ? ` · ${note}` : ""}`}>{caption}</div>
          : <button type="button" className="snapshot-title" title={`Peek at ${label} · ${viewport.width} × ${viewport.height}${note ? ` · ${note}` : ""}`} aria-label={onStage ? `Peek at ${label} on the stage` : `Peek at the ${label} snapshot`} onClick={() => onPeek(key)}>{caption}</button>}
        {forming
          ? <span className="snapshot-state" data-state={state}>{state === "measuring" && <LoaderCircle size={12} className="spin" aria-hidden="true" />}{state === "captured" ? <Check size={12} aria-label="Captured" /> : status}</span>
          : <span className="snapshot-count" data-clean={issues === 0 || undefined} title={issues === 0 ? "No findings at this viewport" : `${issues} ${issues === 1 ? "finding" : "findings"} at this viewport`}>{issues === 0 ? <><Check size={11} aria-hidden="true" /><span className="snapshot-count-unit">Clean</span></> : <>{issues}<span className="snapshot-count-unit"> {issues === 1 ? "issue" : "issues"}</span></>}</span>}
      </header>
      <div className="snapshot-surface" style={{ width: width * zoom, height: height * zoom }} onClick={forming ? undefined : () => onPeek(key)}>
        {snapshot
          ? <img src={snapshot.image} alt={`${label} at ${viewport.width} by ${viewport.height}`} draggable={false} style={{ width: width * zoom, height: snapshot.imageHeight * scale * zoom }} />
          : <div className="snapshot-placeholder" aria-hidden="true"><span>{viewport.width} × {viewport.height}</span></div>}
        {snapshot && snapshot.imageHeight > snapshot.height && snapshot.height * scale < height && <div className="snapshot-fold" style={{ top: snapshot.height * scale * zoom }} aria-hidden="true"><span>Viewport fold</span></div>}
        {ghosts.map(({ finding, marker }) => <span key={`resolved-${finding.id}`} className="resolved-marker" role="img" aria-label={`Resolved since last run: ${finding.title}`} title={`Resolved since last run: ${finding.title}`}
          data-spotlit={lit?.id === finding.id || undefined} style={box(marker.rect)} />)}
        {markers.map(({ finding, marker, index }, at) => <button key={`${finding.id}-${id}`} type="button" className="finding-marker" data-severity={finding.severity} data-classification={finding.classification} data-selected={selected === finding.id || undefined} data-spotlit={lit?.id === finding.id || undefined}
          data-grouped={hidden.has(at) || undefined} data-group={labels.has(at) || undefined}
          aria-label={`Finding ${index}: ${finding.title}`} title={`${index}. ${finding.title}`} style={box(marker.rect)} onClick={(event) => { event.stopPropagation(); onSelect(finding); }}>
          <span>{labels.get(at) ?? index}</span>
        </button>)}
        {markers.length > 0 && <div className="snapshot-rail" aria-hidden="true">
          {markers.map(({ finding, marker }) => <span key={finding.id} data-severity={finding.severity} data-spotlit={lit?.id === finding.id || undefined} style={{ top: `${Math.min(100, Math.max(0, marker.rect.y) / imageHeight * 100)}%` }} />)}
        </div>}
        {(cropped || open) && <div className="snapshot-crop" data-open={open || undefined} data-below={below > 0 || undefined}>
          <button type="button" aria-expanded={open} title={open ? "Crop to the first screen" : below ? `Show the full page: ${below} more ${below === 1 ? "marker" : "markers"} below` : "Show the full page"} aria-label={open ? `Crop ${label} to the first screen` : `Show the full ${label} page${below ? `, ${below} more ${below === 1 ? "marker" : "markers"} below` : ""}`} onClick={(event) => { event.stopPropagation(); onExpand(key); }}>
            {open ? <ChevronsUp size={12} aria-hidden="true" /> : <ChevronsDown size={12} aria-hidden="true" />}
            <span>{open ? "Crop" : below ? `+${below}` : "Full page"}</span>
          </button>
        </div>}
      </div>
    </section>;
  };

  return <>
    {sheet && !stage && <div className="audit-sheet" style={{ left: camera.x + sheet.frame.x * zoom - (sheet.frame.lead ?? 0), top: top(sheet.frame.y, sheet.frame.top), width: sheet.frame.width * zoom + (sheet.frame.lead ?? 0), height: sheet.frame.height * zoom + sheet.frame.inset - sheet.frame.top }}>
      <div className="sheet-head" aria-hidden="true" style={{ height: SHEET_HEAD + PAD * zoom, paddingInline: Math.max(12, PAD * zoom) }}>
        <strong>Snapshots</strong><span className="sheet-head-count">{forming ? `${matrix.boards.filter((board) => board.state === "captured").length} of ${matrix.boards.length} captured` : `${matrix.boards.length} captures`}</span>
        {!forming && <span className="sheet-head-hint">Click a snapshot to look closer</span>}
      </div>
    </div>}
    {sheet && stage && <div className="stage-grid-title" aria-hidden="true" style={{ left: camera.x + sheet.frame.x * zoom, top: top(sheet.frame.y, 0), width: sheet.frame.width * zoom, height: GRID_HEAD }}>
      <strong>All snapshots</strong><span>{matrix.boards.length}{staged ? ` · ringed where finding ${findings.indexOf(staged) + 1} was seen` : ""}</span>
    </div>}
    {sheet?.lanes.map((lane) => lane.label && <div key={`${lane.id}-${lane.y}`} className="sheet-lane-label" data-lane={lane.id} data-gutter={lane.gutter || undefined} aria-hidden="true"
      style={{ left: camera.x + lane.x * zoom, top: top(lane.y, lane.inset - CAPTION - (lane.gutter ? 0 : LANE_LABEL)), width: lane.width * zoom, height: lane.gutter ? CAPTION + 18 : LANE_LABEL }}>
      {lane.label.split(" · ").map((part, at) => <span key={part} data-part={at ? "range" : "name"}>{part}</span>)}
      {!lane.gutter && <span className="lane-rule" />}
    </div>)}
    {stage && staged && <section className="audit-stage" role="region" aria-label={`Stage: finding ${findings.indexOf(staged) + 1}`} data-severity={staged.severity}
      style={{ left: camera.x + stage.frame.x * zoom, top: top(stage.frame.y, stage.frame.top), width: stage.frame.width * zoom, height: stage.frame.height * zoom + stage.frame.inset - stage.frame.top }}>
      <header className="stage-head" style={{ height: STAGE_HEAD }}>
        <span className="stage-index" aria-hidden="true">{findings.indexOf(staged) + 1}</span>
        <strong>{staged.title}</strong>
        <span className="stage-meta"><span className="stage-severity">{staged.severity}</span>{staged.criterion && <span>WCAG {staged.criterion.id} {staged.criterion.name}</span>}<span>Seen on {stage.boards.length} {stage.boards.length === 1 ? "snapshot" : "snapshots"}</span></span>
        <span className="stage-tools">
          <button type="button" onClick={() => onShow(staged)}><Eye size={14} aria-hidden="true" />Show at {staged.worst.width}px</button>
          {stage.boards.some((board) => board.cropped || expanded.has(board.key)) && <button type="button" aria-pressed={stageOpen} onClick={() => onExpandStage(!stageOpen)}>{stageOpen ? <ChevronsUp size={14} aria-hidden="true" /> : <ChevronsDown size={14} aria-hidden="true" />}{stageOpen ? "Crop pages" : "Full pages"}</button>}
          <button type="button" className="stage-back" onClick={onUnstage}><ArrowLeft size={14} aria-hidden="true" />All snapshots<kbd>Esc</kbd></button>
        </span>
      </header>
      {!stage.boards.length && <p className="stage-empty">This finding has no snapshot to show; its widths are on the scope above.</p>}
    </section>}
    {matrix.boards.map((board, index) => tile(board, false, index))}
    {stage?.boards.map((board, index) => tile(board, true, index))}
  </>;
}
