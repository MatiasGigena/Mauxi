import { Type } from "typebox";
import { Check } from "typebox/schema";
import type { PreviewId } from "./preview-contract";

export const PREVIEW_IDS = ["desktop", "mobile"] as const;
export const LABELS = { desktop: "Desktop", mobile: "Mobile" };
export const MIN_ZOOM = 0.1;

/** Automatic fits stop here; only the audit matrix overview fits below it. */
export const FIT_MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const HEADER_HEIGHT = 48;

export interface Point { x: number; y: number }

export interface Camera extends Point { zoom: number }

export interface Artboard extends Point { width: number; height: number }

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

export const clampZoom = (zoom: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

export function zoomAt(camera: Camera, zoom: number, anchor: Point): Camera {
  const next = clampZoom(zoom);

  return { x: anchor.x - (anchor.x - camera.x) * next / camera.zoom, y: anchor.y - (anchor.y - camera.y) * next / camera.zoom, zoom: next };
}

export function dragBoard(board: Artboard, delta: Point, zoom: number): Artboard {
  return { ...board, x: board.x + delta.x / zoom, y: board.y + delta.y / zoom };
}

export function fitCamera(boards: Artboard[], area: { width: number; height: number }, headerHeight = HEADER_HEIGHT, minZoom = FIT_MIN_ZOOM): Camera {
  const left = Math.min(...boards.map((b) => b.x));
  const top = Math.min(...boards.map((b) => b.y));

  const size = (zoom: number) => ({
    width: Math.max(...boards.map((b) => (b.x - left + b.width) * zoom)),
    height: Math.max(...boards.map((b) => (b.y - top + b.height) * zoom + headerHeight)),
  });

  let low = minZoom; let high = MAX_ZOOM;

  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2; const bounds = size(mid);

    if (bounds.width <= area.width - 48 && bounds.height <= area.height - 48) low = mid; else high = mid;
  }

  const bounds = size(low);

  return { x: (area.width - bounds.width) / 2 - left * low, y: (area.height - bounds.height) / 2 - top * low, zoom: low };
}

export function unfocus(state: CanvasState): CanvasState {
  if (!state.focus) return state;

  const { positions } = state.focus;
  const restore = (id: PreviewId): Artboard => ({ ...state.boards[id], x: positions[id].x, y: positions[id].y });

  return { ...state, camera: state.focus.camera, boards: { desktop: restore("desktop"), mobile: restore("mobile") }, focus: null };
}

export function fitBoards(state: CanvasState, ids: readonly PreviewId[], area: { width: number; height: number }, headerHeight = HEADER_HEIGHT): CanvasState {
  const next = unfocus(state);

  return { ...next, camera: fitCamera(ids.map((id) => next.boards[id]), area, headerHeight) };
}

const numberIn = (minimum: number, maximum: number) => Type.Number({ minimum, maximum });

const pointFields = { x: numberIn(-1e6, 1e6), y: numberIn(-1e6, 1e6) };

const cameraSchema = Type.Object({ ...pointFields, zoom: numberIn(MIN_ZOOM, MAX_ZOOM) });

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
