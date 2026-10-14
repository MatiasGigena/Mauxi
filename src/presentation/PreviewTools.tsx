import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Camera, Copy, Link2, Maximize2, Minimize2, MousePointer2, RefreshCw, X } from "lucide-react";
import { LABELS, type Artboard } from "../application/canvas-state";
import type { PreviewId } from "../application/preview-contract";

export function PreviewTools({ id, board, ready, linked, onToggleLinked, canCopy, canCapture, selecting, focused, onSelect, onFocus, onClose, onResize, onReload, onCopy, onCapture }: {
  id: PreviewId; board: Artboard; ready: boolean; linked: boolean; onToggleLinked: () => void;
  canCopy: boolean; canCapture: boolean; onClose: () => void; onResize: (width: number, height: number) => void;
  onReload: () => void; onCopy: () => void; onCapture: () => void;
  selecting: boolean; focused: boolean; onSelect: () => void; onFocus: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const captureHintId = useId();
  const [width, setWidth] = useState(String(board.width));
  const [height, setHeight] = useState(String(board.height));
  const dimensionsChanged = Number(width) !== board.width || Number(height) !== board.height;
  const FocusIcon = focused ? Minimize2 : Maximize2;
  useEffect(() => {
    const node = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    node.showModal();

    return () => { node.close();

 if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true }); };
  }, []);

  return <dialog ref={dialog} className="preview-tools action-modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
    const first = controls[0]; const last = controls.at(-1);

    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header>
      <h2 id={titleId}>{LABELS[id]} actions</h2>
      <button type="button" className="action-modal-close" aria-label="Close actions" onClick={onClose} autoFocus><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="tool-buttons">
      <button type="button" className="preview-tool-action" disabled={!ready} aria-pressed={selecting} onClick={onSelect}>
        <MousePointer2 size={16} aria-hidden="true" /><span>{selecting ? "Stop selecting" : `Select in ${LABELS[id]}`}</span>
      </button>
      <button type="button" className="preview-tool-action preview-tool-focus" aria-pressed={focused} onClick={onFocus}>
        <FocusIcon size={16} aria-hidden="true" /><span>{focused ? "Unfocus" : "Focus"} {LABELS[id]}</span>
      </button>
      <button type="button" className="preview-tool-action" onClick={onReload}>
        <RefreshCw size={16} aria-hidden="true" /><span>Reload preview</span>
      </button>
      <button type="button" className="preview-tool-action" aria-pressed={linked} onClick={onToggleLinked} title="Mirror supported URL navigations between previews, not clicks or forms. Disable for custom action routes."><Link2 size={16} aria-hidden="true" /><span>Link preview routes</span></button>
      <button type="button" className="preview-tool-action" disabled={!canCopy} onClick={onCopy}>
        <Copy size={16} aria-hidden="true" /><span>Copy route to {id === "desktop" ? "mobile" : "desktop"}</span>
      </button>
      <button type="button" className="preview-tool-action" disabled={!canCapture} aria-describedby={!canCapture ? captureHintId : undefined} onClick={onCapture}>
        <Camera size={16} aria-hidden="true" /><span>Capture screenshot</span>
      </button>
      {!canCapture && <p className="preview-tools-hint" id={captureHintId}>Fit the full preview to capture it in the desktop app.</p>}
    </div>
    <form className="viewport-settings" onSubmit={event => { event.preventDefault();

 if (dimensionsChanged) onResize(Number(width), Number(height)); }}>
      <fieldset>
        <legend>Viewport <span>px</span></legend>
        <div className="viewport-fields">
          <label>Width<input type="number" inputMode="numeric" min={240} max={3840} step={1} required value={width} onChange={event => setWidth(event.target.value)} /></label>
          <label>Height<input type="number" inputMode="numeric" min={240} max={2160} step={1} required value={height} onChange={event => setHeight(event.target.value)} /></label>
        </div>
      </fieldset>
      <div className="confirmation-actions">
        <button className="primary viewport-apply" type="submit" disabled={!dimensionsChanged}><span>Apply viewport</span><ArrowUpRight size={16} aria-hidden="true" /></button>
      </div>
    </form>
  </dialog>;
}
