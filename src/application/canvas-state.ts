import { Type } from "typebox";
import { Check } from "typebox/schema";
import type { PreviewId } from "./preview-contract";

export const PREVIEW_IDS = ["desktop", "mobile"] as const;
export const LABELS = { desktop: "Desktop", mobile: "Mobile" };

/** The furthest the user zooms out; the audit matrix overview may fit further, down to OVERVIEW_MIN_ZOOM. */
export const MIN_ZOOM = 0.1;

/** A sheet with many interaction tiles may need less than 10% to fit with the live previews. */
export const OVERVIEW_MIN_ZOOM = 0.05;

/** Automatic fits stop here; only the audit matrix overview fits below it. */
export const FIT_MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const HEADER_HEIGHT = 48;

export interface Point { x: number; y: number }

export interface Camera extends Point { zoom: number }

/** inset: screen px (they do not scale with the camera) between the board's body and its canvas position, beyond its own header; boards in rows below others carry their bands. */
export interface Artboard extends Point { width: number; height: number; inset?: number }

export interface CanvasState {
  version: 1;
  camera: Camera;
  boards: Record<PreviewId, Artboard>;
  linked: boolean;
  focus: { previewId: PreviewId; camera: Camera; positions: Record<PreviewId, Point> } | null;
}

export function defaultCanvas(): CanvasState {
  return {
    version: 1, camera: { x: 0, y: 0, zoom: 0.55 }, linked: true, focus: null,
    boards: { desktop: { x: 0, y: 0, width: 1440, height: 900 }, mobile: { x: 1518, y: 0, width: 390, height: 844 } },
  };
}

/** floor: the lowest zoom allowed, lower than MIN_ZOOM only to keep an overview the camera already shows. */
export const clampZoom = (zoom: number, floor = MIN_ZOOM) => Math.max(floor, Math.min(MAX_ZOOM, zoom));

/** Below MIN_ZOOM (an audit overview), zooming never pushes the camera further out than it already is. */
export const zoomFloor = (camera: Camera) => Math.max(OVERVIEW_MIN_ZOOM, Math.min(MIN_ZOOM, camera.zoom));

export function zoomAt(camera: Camera, zoom: number, anchor: Point): Camera {
  const next = clampZoom(zoom, zoomFloor(camera));

  return { x: anchor.x - (anchor.x - camera.x) * next / camera.zoom, y: anchor.y - (anchor.y - camera.y) * next / camera.zoom, zoom: next };
}

export function dragBoard(board: Artboard, delta: Point, zoom: number): Artboard {
  return { ...board, x: board.x + delta.x / zoom, y: board.y + delta.y / zoom };
}

/**
 * The screen area a fit fills: x, where it starts (default 0); gutter, the screen px kept clear on its left and right
 * (default 24, as above and below). A gutter of 0 puts boards that fill the width exactly on the area's edges.
 */
export interface FitArea { width: number; height: number; x?: number; gutter?: number }

export function fitCamera(boards: Artboard[], area: FitArea, headerHeight = HEADER_HEIGHT, minZoom = FIT_MIN_ZOOM, maxZoom = MAX_ZOOM): Camera {
  const left = Math.min(...boards.map((b) => b.x));
  const top = Math.min(...boards.map((b) => b.y));

  const size = (zoom: number) => ({
    width: Math.max(...boards.map((b) => (b.x - left + b.width) * zoom)),
    height: Math.max(...boards.map((b) => (b.y - top + b.height) * zoom + headerHeight + (b.inset ?? 0))),
  });

  let low = minZoom; let high = Math.max(minZoom, maxZoom);

  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2; const bounds = size(mid);

    if (bounds.width <= area.width - 2 * (area.gutter ?? 24) && bounds.height <= area.height - 48) low = mid; else high = mid;
  }

  const bounds = size(low);

  // Boards taller than the area even at minZoom hang from its top (past the gutter) rather than from its middle, so their headers stay in view.
  return { x: (area.x ?? 0) + (area.width - bounds.width) / 2 - left * low, y: Math.max(24, (area.height - bounds.height) / 2) - top * low, zoom: low };
}

export function unfocus(state: CanvasState): CanvasState {
  if (!state.focus) return state;

  const { positions } = state.focus;
  const restore = (id: PreviewId): Artboard => ({ ...state.boards[id], x: positions[id].x, y: positions[id].y });

  return { ...state, camera: state.focus.camera, boards: { desktop: restore("desktop"), mobile: restore("mobile") }, focus: null };
}

export function fitBoards(state: CanvasState, ids: readonly PreviewId[], area: FitArea, headerHeight = HEADER_HEIGHT): CanvasState {
  const next = unfocus(state);

  return { ...next, camera: fitCamera(ids.map((id) => next.boards[id]), area, headerHeight) };
}

const numberIn = (minimum: number, maximum: number) => Type.Number({ minimum, maximum });

const pointFields = { x: numberIn(-1e6, 1e6), y: numberIn(-1e6, 1e6) };

const cameraSchema = Type.Object({ ...pointFields, zoom: numberIn(OVERVIEW_MIN_ZOOM, MAX_ZOOM) });

const artboardSchema = Type.Object({ ...pointFields, width: Type.Integer({ minimum: 240, maximum: 3840 }), height: Type.Integer({ minimum: 240, maximum: 2160 }) });

const pointSchema = Type.Object(pointFields);

const canvasSchema = Type.Object({
  version: Type.Literal(1),
  camera: cameraSchema,
  linked: Type.Boolean(),
  boards: Type.Object({ desktop: artboardSchema, mobile: artboardSchema }),
  focus: Type.Union([
    Type.Null(),
    Type.Object({
      previewId: Type.Union([Type.Literal("desktop"), Type.Literal("mobile")]),
      camera: cameraSchema,
      positions: Type.Object({ desktop: pointSchema, mobile: pointSchema }),
    }),
  ]),
});

export function isCanvasState(value: unknown): value is CanvasState {
  try { if (JSON.stringify(value).length > 4096) return false; } catch { return false; }

  return Check(canvasSchema, value);
}
