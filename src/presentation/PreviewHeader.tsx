import type { PointerEventHandler } from "react";
import { Ellipsis, Maximize2, Minimize2, MousePointer2 } from "lucide-react";
import { LABELS, type Artboard, type Point } from "../application/canvas-state";
import type { PreviewId } from "../application/preview-contract";

interface PreviewHeaderProps {
  id: PreviewId;
  board: Artboard;
  ready: boolean;
  locked: boolean;
  interacting: boolean;
  selecting: boolean;
  focused: boolean;
  onDrag: PointerEventHandler<HTMLElement>;
  onMove: (delta: Point) => void;
  onSelect: () => void;
  onFocus: () => void;
  onTools: () => void;
}

export function PreviewHeader({ id, board, ready, locked, interacting, selecting, focused, onDrag, onMove, onSelect, onFocus, onTools }: PreviewHeaderProps) {
  const label = LABELS[id];
  const focusLabel = `${focused ? "Unfocus" : "Focus"} ${label}`;
  const FocusIcon = focused ? Minimize2 : Maximize2;

  return <header className="artboard-header" inert={locked} onPointerDown={event => {
    if (!(event.target as Element).closest("button:not(.board-grip)")) onDrag(event);
  }}>
    <button type="button" className="board-grip" aria-label={`Move ${label} artboard with arrow keys`} title="Drag to move · arrow keys when focused" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 100 : 20;
      onMove({ x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 });
    }}>
      <strong>{label}{interacting && <span className="preview-interaction-label"> · Interacting</span>}</strong>
      <span className={ready ? "bridge-ready" : ""}>{board.width} × {board.height}</span>
    </button>
    <div className="artboard-actions">
      <button type="button" className="board-select" aria-label={`Select in ${label}`} title="Pick DOM target · use ↑/↓ for child/parent and [ / ] for overlaps" aria-pressed={selecting} disabled={!ready} onClick={onSelect}>
        <MousePointer2 size={16} aria-hidden="true" />
      </button>
      <button type="button" className="board-focus" aria-label={focusLabel} title={focusLabel} aria-pressed={focused} onClick={onFocus}>
        <FocusIcon size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label={`${label} actions`} title={`${label} actions`} aria-haspopup="dialog" onClick={onTools}>
        <Ellipsis size={16} aria-hidden="true" />
      </button>
    </div>
  </header>;
}
