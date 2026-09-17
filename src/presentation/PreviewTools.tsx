import { useEffect, useRef, useState } from "react";
import { LABELS, type Artboard } from "../application/canvas-state";
import type { PreviewId } from "../application/preview-contract";

export function PreviewTools({ id, board, route, ready, generation, logs, canCopy, canCapture, onClose, onResize, onReload, onCopy, onCapture }: {
  id: PreviewId; board: Artboard; route: string; ready: boolean; generation: string; logs: string[];
  canCopy: boolean; canCapture: boolean; onClose: () => void; onResize: (width: number, height: number) => void;
  onReload: () => void; onCopy: () => void; onCapture: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [width, setWidth] = useState(board.width);
  const [height, setHeight] = useState(board.height);
  useEffect(() => {
    const node = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    node.showModal();
    return () => { node.close(); opener?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="preview-tools" aria-labelledby="tools-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2 id="tools-title">{LABELS[id]} actions</h2><button aria-label="Close actions" onClick={onClose} autoFocus>×</button></header>
    <p className="current-route" title={route}>{route || "Waiting for preview…"}</p>
    <div className="tool-buttons">
      <button onClick={onReload}>Reload preview</button>
      <button disabled={!canCopy} onClick={onCopy}>Copy route to {id === "desktop" ? "mobile" : "desktop"}</button>
      <button disabled={!canCapture} onClick={onCapture}>Capture screenshot</button>
      {!canCapture && <small>Capture needs the Linux host and the full viewport visible. Use Focus or Fit both first.</small>}
      <button disabled title="External opening is not yet available">Open externally · unavailable</button>
    </div>
    <form className="viewport-settings" onSubmit={(event) => { event.preventDefault(); onResize(width, height); }}>
      <fieldset><legend>Viewport · CSS pixels</legend><label>Width<input type="number" min={240} max={3840} step={1} required value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label>Height<input type="number" min={240} max={2160} step={1} required value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label><button type="submit">Apply viewport</button></fieldset>
    </form>
    <details><summary>Preview diagnostics</summary><dl><dt>Bridge</dt><dd>{ready ? "Connected" : "Disconnected — reload to reconnect"}</dd><dt>Document generation</dt><dd>{generation || "Pending"}</dd><dt>Selection</dt><dd>Basic point picker available. Hierarchy and full selector are not yet implemented.</dd><dt>Route linking</dt><dd>Same-origin URLs only. Auth, callback, action routes and form navigation are excluded. Unlink for custom side-effectful GET routes.</dd></dl>{logs.length > 0 && <pre>{logs.slice(-80).join("\n")}</pre>}</details>
    <button disabled>Selection hierarchy · unavailable</button>
  </dialog>;
}
