export interface RectEdges { left: number; top: number; right: number; bottom: number }
export interface RectSize { x: number; y: number; width: number; height: number }

/** Converts a frame-local CSS-pixel crop to shell CSS pixels and clips it to
 * the transformed iframe, canvas, and shell viewport. Device scaling is left
 * to Electron's capturePage, which accepts display-independent coordinates. */
export function selectionCropToShell(
  crop: RectSize,
  viewport: { width: number; height: number },
  frame: RectEdges,
  canvas: RectEdges,
  shell: RectEdges,
): { shell: RectSize; preview: RectSize } | null {
  const values = [crop.x, crop.y, crop.width, crop.height, viewport.width, viewport.height, frame.left, frame.top, frame.right, frame.bottom];
  if (values.some((value) => !Number.isFinite(value)) || crop.width <= 0 || crop.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const frameWidth = frame.right - frame.left;
  const frameHeight = frame.bottom - frame.top;
  if (frameWidth <= 0 || frameHeight <= 0) return null;
  const scaleX = frameWidth / viewport.width;
  const scaleY = frameHeight / viewport.height;
  const intended = {
    left: frame.left + crop.x * scaleX,
    top: frame.top + crop.y * scaleY,
    right: frame.left + (crop.x + crop.width) * scaleX,
    bottom: frame.top + (crop.y + crop.height) * scaleY,
  };
  const left = Math.max(frame.left, canvas.left, shell.left, intended.left);
  const top = Math.max(frame.top, canvas.top, shell.top, intended.top);
  const right = Math.min(frame.right, canvas.right, shell.right, intended.right);
  const bottom = Math.min(frame.bottom, canvas.bottom, shell.bottom, intended.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    shell: { x: left, y: top, width: right - left, height: bottom - top },
    preview: { x: (left - frame.left) / scaleX, y: (top - frame.top) / scaleY, width: (right - left) / scaleX, height: (bottom - top) / scaleY },
  };
}
