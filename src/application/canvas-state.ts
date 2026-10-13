import type { PreviewId } from "./preview-contract";

export const PREVIEW_IDS = ["desktop", "mobile"] as const;
export const LABELS = { desktop: "Desktop", mobile: "Mobile" };
export const MIN_ZOOM = 0.25;
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
export function fitCamera(boards: Artboard[], area: { width: number; height: number }, headerHeight = HEADER_HEIGHT): Camera {
  const left = Math.min(...boards.map((b) => b.x));
  const top = Math.min(...boards.map((b) => b.y));
  const size = (zoom: number) => ({
    width: Math.max(...boards.map((b) => (b.x - left + b.width) * zoom)),
    height: Math.max(...boards.map((b) => (b.y - top + b.height) * zoom + headerHeight)),
  });
  let low = MIN_ZOOM; let high = MAX_ZOOM;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2; const bounds = size(mid);
    if (bounds.width <= area.width - 48 && bounds.height <= area.height - 48) low = mid; else high = mid;
  }
  const bounds = size(low);
  return { x: (area.width - bounds.width) / 2 - left * low, y: (area.height - bounds.height) / 2 - top * low, zoom: low };
}
export function unfocus(state: CanvasState): CanvasState {
  if (!state.focus) return state;
  return { ...state, camera: state.focus.camera, boards: Object.fromEntries(PREVIEW_IDS.map((id) => [id, { ...state.boards[id], x: state.focus!.positions[id].x, y: state.focus!.positions[id].y }])) as CanvasState["boards"], focus: null };
}
/** Leaves focus first, then fits the restored (not the focused) board positions. */
export function fitBoards(state: CanvasState, ids: readonly PreviewId[], area: { width: number; height: number }, headerHeight = HEADER_HEIGHT): CanvasState {
  const next = unfocus(state);
  return { ...next, camera: fitCamera(ids.map((id) => next.boards[id]), area, headerHeight) };
}
const numberIn = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
function point(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const p = value as Point;
  return numberIn(p.x, -1e6, 1e6) && numberIn(p.y, -1e6, 1e6);
}
const camera = (value: unknown) => point(value) && numberIn((value as Camera).zoom, MIN_ZOOM, MAX_ZOOM);
export function isCanvasState(value: unknown): value is CanvasState {
  if (!value || typeof value !== "object") return false;
  try { if (JSON.stringify(value).length > 4096) return false; } catch { return false; }
  const v = value as CanvasState;
  return v.version === 1 && camera(v.camera) && typeof v.linked === "boolean"
    && !!v.boards && PREVIEW_IDS.every((id) => point(v.boards[id]) && Number.isInteger(v.boards[id].width) && numberIn(v.boards[id].width, 240, 3840) && Number.isInteger(v.boards[id].height) && numberIn(v.boards[id].height, 240, 2160))
    && (v.focus === null || (!!v.focus && PREVIEW_IDS.includes(v.focus.previewId) && camera(v.focus.camera) && !!v.focus.positions && PREVIEW_IDS.every((id) => point(v.focus!.positions[id]))));
}
