import { AUDIT_PROFILES, type AuditFinding } from "./audit-contract";
import { FIT_GAP, LIVE_FRAME, type Artboard, type Point } from "./canvas-state";

/*
 * The audit sheet: one surface below the live previews where every snapshot is a tile of one of three canvas widths,
 * grouped into lanes by what it tests, instead of an artboard at its real size.
 *
 * Ways it can fail, each checked by tests/browser-e2e/audit-canvas.spec.ts or tests/audit-e2e/entry-audit.spec.ts:
 * 1. Tiles overlap, or a caption or lane label covers the row above, at some zoom (screen-space bands are not counted).
 * 2. fitCamera under-counts the screen-space bands above a row, so the last row falls below the free canvas.
 * 3. Tiles render in another order than the input (profile order), so DOM order and keyboard order change.
 * 4. Tiles jump while a run forms: placeholders and streamed snapshots must keep the viewport height until the report.
 * 5. A profile matches no lane (an unknown interaction prefix) and disappears; it must fall back to its width lane.
 * 6. An empty lane still takes space or shows a label.
 * 7. Image and markers are scaled differently, so markers drift off their elements.
 * 8. A crop hides markers below it without a trace; the tile must say it is cropped and how many markers it hides.
 * 9. A short snapshot (400% zoom is 256 px tall) gets a tall empty tile.
 * 10. A lane with many tiles (interaction boards) runs far wider than the rest; it wraps onto more lines.
 * 12. Opening one tile reflows the lanes; rows are chosen from cropped heights, so it only pushes the rows below down.
 * 11. No items or no live boards yields a sheet anyway.
 */

/** Screen-space bands (px) that keep their size at every zoom: the sheet's heading, a lane label and a tile caption. */
export const SHEET_HEAD = 40;
export const LANE_LABEL = 22;
export const CAPTION = 26;

/** Canvas units at the bottom of a cropped tile under its fade; a marker that starts there counts as below the crop. */
export const CROP_FADE = 24;

export type LaneId = "compact" | "medium" | "wide" | "stress" | "interaction";

const LANES: Array<{ id: LaneId; label: string }> = [
  { id: "compact", label: "Compact · up to 480" },
  { id: "medium", label: "Medium · 481–1024" },
  { id: "wide", label: "Wide · 1025 and up" },
  { id: "stress", label: "Zoom & text spacing" },
  { id: "interaction", label: "Interaction" },
];

/** Tile classes: canvas width and the most of the page shown before cropping. True widths span 1 : 6; tiles span 1 : 2. */
const TILES = { S: { width: 260, crop: 540 }, M: { width: 360, crop: 480 }, L: { width: 520, crop: 400 } };

const TILE_GAP = 40;
const LANE_GAP = 72;
const ROW_GAP = 56;

/** Canvas units between the sheet's edge and its tiles. */
export const PAD = 48;

const STAGE_GAP = 140;

/** Screen px from the live previews' frames down to the sheet: the sheet starts right below them in canvas units and is lifted this much on screen, so the gap matches the fit's at every zoom. */
const SHEET_LIFT = LIVE_FRAME + FIT_GAP;
const LINE_MAX = 2400;

/** The packing scores rows for a landscape canvas of this aspect at about this zoom (the screen bands' share). */
const ASPECT = 1.6;
const TYPICAL_ZOOM = 0.2;

/** id and viewport of a board; content: the height it would show uncropped (the viewport while forming, the full page after). */
export interface SheetItem { id: string; width: number; height: number; content: number }

/** scale: canvas units per CSS px of the snapshot; inset: screen px between the tile's canvas top and its body (Artboard.inset). */
export interface SheetTile extends Artboard { id: string; lane: LaneId; scale: number; full: number; cropped: boolean; inset: number }

/** A lane label above one line of tiles (in stage mode's grid, beside it: gutter); continued lines carry no label. */
export interface SheetLane { id: LaneId; label: string | null; x: number; y: number; width: number; inset: number; gutter?: boolean }

/** frame: the sheet surface; its heading sits at frame.y, one live header band and top screen px below the canvas position; inset counts every screen band down to its bottom; lead, the screen px it reaches left to line up with the live previews' frames. */
export interface Sheet { tiles: SheetTile[]; lanes: SheetLane[]; frame: Artboard & { inset: number; top: number } }

const PROFILES = new Map(AUDIT_PROFILES.map((profile) => [profile.id, profile]));

export function laneOf(id: string, width: number): LaneId {
  if (/^(focus|menu|hover)-/.test(id)) return "interaction";
  const profile = PROFILES.get(id);

  if (profile?.viewportOnly || profile?.textSpacing) return "stress";

  return width <= 480 ? "compact" : width <= 1024 ? "medium" : "wide";
}

const tileClass = (width: number) => TILES[width <= 480 ? "S" : width <= 1024 ? "M" : "L"];

/** height: the tallest tile as shown; crop: as cropped, which alone decides the rows. */
interface Unit { lane: LaneId; first: boolean; items: number[]; width: number; height: number; crop: number }

/** Wraps units in order into rows no wider than limit. */
function wrap(units: Unit[], limit: number): Unit[][] {
  const rows: Unit[][] = [];
  let width = Infinity;

  for (const unit of units) {
    if (width + LANE_GAP + unit.width > limit) { rows.push([unit]); width = unit.width; } else { rows.at(-1)!.push(unit); width += LANE_GAP + unit.width; }
  }

  return rows;
}

const rowWidth = (row: Unit[]) => row.reduce((sum, unit) => sum + unit.width, (row.length - 1) * LANE_GAP);

/**
 * Lays the sheet out below the live previews, in canvas coordinates. Tiles keep the input order; lanes follow it too,
 * since profile order already runs compact → medium → wide → stress → interaction. expanded: tiles shown uncropped.
 */
export function layoutSheet(items: SheetItem[], live: Artboard[], expanded: ReadonlySet<string> = new Set()): Sheet | null {
  if (!items.length || !live.length) return null;
  const left = Math.min(...live.map((board) => board.x));
  const top = Math.min(...live.map((board) => board.y));
  const bottom = Math.max(...live.map((board) => board.y + board.height));
  const span = Math.max(...live.map((board) => board.x + board.width)) - left;

  const sized = items.map((item) => {
    const tile = tileClass(item.width);
    const scale = tile.width / item.width;
    const full = item.content * scale;
    const crop = Math.min(full, tile.crop);

    return { item, lane: laneOf(item.id, item.width), width: tile.width, height: expanded.has(item.id) ? full : crop, crop, scale, full };
  });

  // Each lane becomes one or more lines of tiles no wider than LINE_MAX.
  const units: Unit[] = [];

  for (const lane of LANES) {
    let unit: Unit | null = null;

    for (const [index, tile] of sized.entries()) {
      if (tile.lane !== lane.id) continue;

      if (!unit || unit.width + TILE_GAP + tile.width > LINE_MAX) { unit = { lane: lane.id, first: !unit, items: [], width: -TILE_GAP, height: 0, crop: 0 }; units.push(unit); }

      unit.items.push(index); unit.width += TILE_GAP + tile.width; unit.height = Math.max(unit.height, tile.height); unit.crop = Math.max(unit.crop, tile.crop);
    }
  }

  // Try every row width the lines can wrap at; keep the rows that let a landscape camera show the stage and sheet largest.
  const limits = new Set<number>();

  for (let start = 0; start < units.length; start++) {
    for (let end = start, width = -LANE_GAP; end < units.length; end++) { width += LANE_GAP + units[end].width; limits.add(width); }
  }

  let best = { rows: units.map((unit) => [unit]), scale: 0 };

  for (const limit of [...limits].sort((a, b) => a - b)) {
    const rows = wrap(units, limit);
    const width = Math.max(span, Math.max(...rows.map(rowWidth)) + 2 * PAD);
    const bands = (SHEET_HEAD + rows.length * (LANE_LABEL + CAPTION)) / TYPICAL_ZOOM;
    const height = bottom - top + SHEET_LIFT / TYPICAL_ZOOM + 2 * PAD + rows.reduce((sum, row) => sum + Math.max(...row.map((unit) => unit.crop)), (rows.length - 1) * ROW_GAP) + bands;
    const scale = Math.min(ASPECT / width, 1 / height);

    if (scale > best.scale * 1.000001) best = { rows, scale };
  }

  const sheetTop = bottom;
  const tiles: SheetTile[] = [];
  const lanes: SheetLane[] = [];
  let y = sheetTop + PAD;
  let inset = SHEET_LIFT;

  best.rows.forEach((row, index) => {
    inset = SHEET_LIFT + SHEET_HEAD + (index + 1) * (LANE_LABEL + CAPTION);
    let x = left + PAD;

    for (const unit of row) {
      lanes.push({ id: unit.lane, label: unit.first ? LANES.find((lane) => lane.id === unit.lane)!.label : null, x, y, width: unit.width, inset });

      for (const at of unit.items) {
        const tile = sized[at];
        tiles[at] = { id: tile.item.id, lane: tile.lane, x, y, width: tile.width, height: tile.height, scale: tile.scale, full: tile.full, cropped: tile.full > tile.height + 0.5, inset };
        x += tile.width + TILE_GAP;
      }

      x += LANE_GAP - TILE_GAP;
    }

    y += Math.max(...row.map((unit) => unit.height)) + ROW_GAP;
  });

  const width = Math.max(span, Math.max(...best.rows.map(rowWidth)) + 2 * PAD);

  return { tiles, lanes, frame: { x: left, y: sheetTop, width, height: y - ROW_GAP + PAD - sheetTop, inset, top: SHEET_LIFT, lead: LIVE_FRAME } };
}

/*
 * Stage mode, while a finding is selected: the same tiles move into a compact grid beside the live previews, one line per
 * lane, and the snapshots the finding was seen on are laid out again below, large, on the stage.
 *
 * Ways it can fail, each checked by tests/browser-e2e/audit-canvas.spec.ts:
 * 1. The grid or the stage overlaps the live previews or each other at some zoom (their screen bands are not counted).
 * 2. A tile disappears from the grid while staged, so DOM order or a "Seen at" chip loses its target.
 * 3. The stage shows a tile the finding was not seen on, or misses one it was.
 * 4. A stage tile's markers use another scale than its image.
 * 5. Many staged snapshots run the stage far wider than the screen; it wraps.
 */

/** Screen-space bands (px) of stage mode: the grid's title, the stage's header with the finding and its tools. */
export const GRID_HEAD = 28;
export const STAGE_HEAD = 52;

/** Grid tiles are all one width and cropped short; stage tiles keep the sheet's three classes, about twice the size. */
const GRID_TILE = { width: 300, crop: 190 };
const STAGE_TILES = { S: { width: 520, crop: 800 }, M: { width: 680, crop: 680 }, L: { width: 960, crop: 560 } };
const GRID_GAP = 160;
const GRID_LINE = 5;

/** Canvas units left of the grid's tiles for the lane names. */
const GUTTER = 440;

const STAGE_LINE = 5;

/** The stage: its tiles in focus order, and its surface; frame.inset counts every screen band down to its bottom, top the ones above it. */
export interface Stage { tiles: SheetTile[]; frame: Artboard & { inset: number; top: number } }

/** grid: every tile in stage mode, in input order; lanes: the grid's line labels; head: where the grid's title sits. */
export interface StageLayout { grid: Sheet; stage: Stage }

/**
 * Lays out stage mode in canvas coordinates. focus: the ids the selected finding was seen on, in input order; expanded:
 * keys of tiles shown uncropped (a grid tile by its id, a stage tile as "stage:" + id).
 */
export function layoutStage(items: SheetItem[], live: Artboard[], focus: string[], expanded: ReadonlySet<string> = new Set()): StageLayout | null {
  if (!items.length || !live.length) return null;
  const left = Math.min(...live.map((board) => board.x));
  const top = Math.min(...live.map((board) => board.y));
  const right = Math.max(...live.map((board) => board.x + board.width));
  const bottom = Math.max(...live.map((board) => board.y + board.height));

  // The grid: one line per lane (long lanes wrap), tiles of one width, beside the previews, lane names in a gutter.
  const gridLeft = right + GRID_GAP;
  const tiles: SheetTile[] = [];
  const lanes: SheetLane[] = [];
  let y = top;
  let line = 0;

  for (const lane of LANES) {
    const members = items.flatMap((item, index) => laneOf(item.id, item.width) === lane.id ? [{ item, index }] : []);

    for (let start = 0; start < members.length; start += GRID_LINE) {
      const inset = GRID_HEAD + (line + 1) * CAPTION;
      let x = gridLeft + GUTTER;
      let height = 0;
      lanes.push({ id: lane.id, label: start === 0 ? lane.label : null, x: gridLeft, y, width: GUTTER - TILE_GAP, inset, gutter: true });

      for (const { item, index } of members.slice(start, start + GRID_LINE)) {
        const scale = GRID_TILE.width / item.width;
        const full = item.content * scale;
        const shown = expanded.has(item.id) ? full : Math.min(full, GRID_TILE.crop);
        tiles[index] = { id: item.id, lane: lane.id, x, y, width: GRID_TILE.width, height: shown, scale, full, cropped: full > shown + 0.5, inset };
        x += GRID_TILE.width + TILE_GAP;
        height = Math.max(height, shown);
      }

      y += height + ROW_GAP;
      line++;
    }
  }

  const gridBottom = y - ROW_GAP;
  const gridBands = GRID_HEAD + line * CAPTION;
  const gridWidth = Math.max(...tiles.flatMap((tile) => tile ? [tile.x + tile.width] : [])) - gridLeft;
  const grid: Sheet = { tiles, lanes, frame: { x: gridLeft, y: top, width: gridWidth, height: gridBottom - top, inset: gridBands, top: 0 } };

  // The stage: the focused snapshots at stage size, below whichever of the previews and the grid reaches lower. The grid's
  // screen bands count at every zoom, so the stage always clears them.
  const base = gridBands;
  const stageTop = Math.max(bottom, gridBottom) + STAGE_GAP;
  const staged = focus.flatMap((id) => items.filter((item) => item.id === id));
  const stageTiles: SheetTile[] = [];
  let rowY = stageTop + PAD;
  let rows = 0;
  let widest = 0;

  for (let start = 0; start < staged.length; start += STAGE_LINE) {
    const inset = base + STAGE_HEAD + (rows + 1) * CAPTION;
    let x = left + PAD;
    let height = 0;

    for (const item of staged.slice(start, start + STAGE_LINE)) {
      const tile = STAGE_TILES[item.width <= 480 ? "S" : item.width <= 1024 ? "M" : "L"];
      const scale = tile.width / item.width;
      const full = item.content * scale;
      const shown = expanded.has(`stage:${item.id}`) ? full : Math.min(full, tile.crop);
      stageTiles.push({ id: item.id, lane: laneOf(item.id, item.width), x, y: rowY, width: tile.width, height: shown, scale, full, cropped: full > shown + 0.5, inset });
      x += tile.width + TILE_GAP * 2;
      height = Math.max(height, shown);
    }

    widest = Math.max(widest, x - TILE_GAP * 2 - left + PAD);
    rowY += height + ROW_GAP;
    rows++;
  }

  const width = Math.max(right - left, gridLeft + gridWidth - left, widest);
  const stageHeight = (rows ? rowY - ROW_GAP : stageTop + PAD) + PAD - stageTop;

  return { grid, stage: { tiles: stageTiles, frame: { x: left, y: stageTop, width, height: stageHeight, top: base, inset: base + STAGE_HEAD + rows * CAPTION } } };
}

/** Groups pins (screen px) that sit within radius of a group's first pin; members keep input order. */
export function clusterPins(points: Point[], radius: number): number[][] {
  const groups: Array<{ at: Point; members: number[] }> = [];

  points.forEach((point, index) => {
    const group = groups.find((item) => Math.hypot(item.at.x - point.x, item.at.y - point.y) <= radius);

    if (group) group.members.push(index); else groups.push({ at: point, members: [index] });
  });

  return groups.map((group) => group.members);
}

/** Whether a finding was seen on a profile's board: it has a marker there or names the profile. */
export function seenOn(finding: AuditFinding, profileId: string) {
  return finding.profiles.includes(profileId) || finding.markers.some((marker) => marker.profileId === profileId);
}

/** A few characters that tell a board apart from others of the same width once its name no longer fits: "400%", "Aa" for text spacing, "Menu" for an interaction board. */
export function profileTag(profileId: string): string {
  const interaction = /^(focus|menu|hover)-/.exec(profileId)?.[1];
  const zoom = /zoom-(\d+)/.exec(profileId)?.[1];
  const parts = [interaction && { focus: "Tab", menu: "Menu", hover: "Hover" }[interaction], zoom && `${zoom}%`, profileId.includes("text-spacing") && "Aa"];

  return parts.filter(Boolean).join(" ");
}
