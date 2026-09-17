import { useRef, useState } from "react";
import type { StoredSelection } from "../application/selection-state";

export function ChatDock({ height, onResize, selections, onRemove, onRevalidate }: {
  height: number; onResize: (height: number) => void; selections: StoredSelection[];
  onRemove: (id: string) => void; onRevalidate: (item: StoredSelection) => void;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const drag = useRef<{ y: number; height: number } | null>(null);
  return <footer className="chat-dock" aria-label="Chat" style={{ height }}>
    <div className="dock-resizer" role="separator" tabIndex={0} aria-label="Resize chat" aria-orientation="horizontal" aria-valuemin={144} aria-valuemax={600} aria-valuenow={Math.round(height)}
      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height }; }}
      onPointerMove={(event) => { if (drag.current) onResize(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); onResize(event.key === "Home" ? 144 : event.key === "End" ? 600 : height + (event.key === "ArrowUp" ? 24 : -24)); } }}><span /></div>
    <div className="chat-content">
      <div className="dock-heading"><strong>Conversation</strong><span>Local demo · no model connected</span></div>
      {selections.length > 0 && <div className="selection-list" data-testid="selection-list">{selections.map((item) => <article className={`selection-chip ${item.status}`} key={item.capture.selectionId}>
        <span className="preview-pill">{item.capture.previewId}</span><strong>{item.capture.element.label}</strong>
        <code title={item.capture.source.filePath}>{item.capture.source.filePath ? `${item.capture.source.filePath.split(/[\\/]/).slice(-2).join("/")}:${item.capture.source.lineNumber ?? "?"}` : "Source unresolved"}</code>
        <span>{item.status === "stale" ? "Stale" : item.capture.source.method}</span>
        <button disabled={item.requiresRepick} title={item.staleReason} onClick={() => onRevalidate(item)}>{item.requiresRepick ? "Pick again" : "Revalidate"}</button><button aria-label={`Remove selection ${item.capture.element.label}`} onClick={() => onRemove(item.capture.selectionId)}>×</button>
      </article>)}</div>}
      <div className="conversation" role="log" aria-label="Demo conversation"><p>{messages.length ? `You: ${messages.at(-1)}` : "Explore both previews, then leave a note about what you’d like to change."}</p>{messages.length > 0 && <p>Demo: Your note stays here. No project files were changed.</p>}</div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; setMessages((items) => [...items, draft.trim()].slice(-20)); setDraft(""); }}>
        <label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" placeholder="Describe a change…" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" disabled={!draft.trim()}>Send demo</button>
      </form>
    </div>
  </footer>;
}
