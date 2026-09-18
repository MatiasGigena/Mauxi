import { useRef, useState } from "react";
import type { StoredSelection } from "../application/selection-state";

export function ChatDock({ height, onResize, selections, onRemove, onRevalidate, onBeforeSend }: {
  height: number; onResize: (height: number) => void; selections: StoredSelection[];
  onRemove: (id: string) => void; onRevalidate: (item: StoredSelection) => void;
  onBeforeSend: () => Promise<{ ok: boolean; message?: string }>;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [inspected, setInspected] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const inspectedItem = selections.find((item) => item.capture.selectionId === inspected);

  async function submit() {
    if (!draft.trim() || sending) return;
    setSending(true); setSendError("");
    try {
      const result = await onBeforeSend();
      if (!result.ok) { setSendError(result.message ?? "Attached context must be refreshed before sending."); return; }
      setMessages((items) => [...items, draft.trim()].slice(-20)); setDraft("");
    } finally { setSending(false); }
  }

  return <footer className="chat-dock" aria-label="Chat" style={{ height }}>
    <div className="dock-resizer" role="separator" tabIndex={0} aria-label="Resize chat" aria-orientation="horizontal" aria-valuemin={144} aria-valuemax={600} aria-valuenow={Math.round(height)}
      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height }; }}
      onPointerMove={(event) => { if (drag.current) onResize(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); onResize(event.key === "Home" ? 144 : event.key === "End" ? 600 : height + (event.key === "ArrowUp" ? 24 : -24)); } }}><span /></div>
    <div className="chat-content">
      <div className="dock-heading"><strong>Conversation</strong><span>Local demo · no model connected</span></div>
      {selections.length > 0 && <div className="selection-list" data-testid="selection-list">{selections.map((item) => {
        const source = item.capture.source;
        const sourceLabel = source.verification === "verified"
          ? `${source.filePath.split(/[\\/]/).slice(-2).join("/")}:${source.lineNumber ?? "?"}`
          : source.verification === "library" ? "Library source" : source.filePath ? `Source ambiguous (${source.filePath}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"})` : "Source unresolved";
        return <article className={`selection-chip ${item.status}`} key={item.capture.selectionId}>
          <span className="preview-pill">{item.capture.previewId}</span><strong>{item.capture.element.label}</strong>
          <code title={source.verification === "verified" ? source.filePath : undefined}>{sourceLabel}</code>
          <span>{item.status === "stale" ? "Stale" : source.verification === "verified" ? `${source.method} · verified JSX` : source.verification}</span>
          {item.capture.support.status === "unsupported" && <span className="unsupported">Unsupported source</span>}
          <button aria-expanded={inspected === item.capture.selectionId} onClick={() => setInspected(inspected === item.capture.selectionId ? null : item.capture.selectionId)}>Inspect</button>
          <button disabled={item.requiresRepick} title={item.staleReason} onClick={() => onRevalidate(item)}>{item.requiresRepick ? "Pick again" : "Revalidate"}</button>
          <button aria-label={`Remove selection ${item.capture.element.label}`} onClick={() => { onRemove(item.capture.selectionId); if (inspected === item.capture.selectionId) setInspected(null); }}>×</button>
        </article>;
      })}</div>}
      {inspectedItem && <section className="selection-inspector" aria-label={`Selection details for ${inspectedItem.capture.element.label}`}>
        <header><strong>{inspectedItem.capture.element.label}</strong><span>{inspectedItem.status === "current" ? "Live capture" : "Historical · stale"}</span></header>
        {inspectedItem.capture.support.reason && <p className="selection-warning">{inspectedItem.capture.support.reason}</p>}
        <dl>
          <dt>Workspace / preview</dt><dd>{inspectedItem.capture.workspaceId} · {inspectedItem.capture.previewId}</dd>
          <dt>Route</dt><dd>{inspectedItem.capture.url}</dd>
          <dt>Captured</dt><dd>{inspectedItem.capture.capturedAt} · generation {inspectedItem.capture.documentGeneration.slice(0, 8)}</dd>
          <dt>Viewport / bounds</dt><dd>{inspectedItem.capture.viewport.width}×{inspectedItem.capture.viewport.height} CSS px · {Math.round(inspectedItem.capture.bounds.x)},{Math.round(inspectedItem.capture.bounds.y)} {Math.round(inspectedItem.capture.bounds.width)}×{Math.round(inspectedItem.capture.bounds.height)}</dd>
          <dt>Bounded text</dt><dd>{inspectedItem.capture.element.text || "None"}</dd>
          <dt>JSX provenance</dt><dd>{inspectedItem.capture.source.verification === "verified" ? `${inspectedItem.capture.source.filePath}:${inspectedItem.capture.source.lineNumber ?? "?"}:${inspectedItem.capture.source.columnNumber ?? "?"} · SHA-256 ${inspectedItem.capture.source.fileFingerprint}` : `${inspectedItem.capture.source.verification} · ${inspectedItem.capture.source.filePath || "No source location"}`}</dd>
          <dt>DOM ancestry</dt><dd>{inspectedItem.capture.domAncestry.map((entry) => `${entry.selected ? "selected " : ""}<${entry.tag}>`).join(" → ")}</dd>
          <dt>React ownership</dt><dd>{inspectedItem.capture.componentOwners.length ? inspectedItem.capture.componentOwners.map((owner) => `${owner.role}: ${owner.componentName}${owner.ownership === "library" ? " (library)" : owner.ownership === "unknown" ? " (unverified)" : ""}`).join(" → ") : "Unavailable — DOM ancestry is not being presented as React ownership."}</dd>
          <dt>Screenshot crop</dt><dd>{inspectedItem.capture.screenshot.status === "captured" ? `${inspectedItem.capture.screenshot.width}×${inspectedItem.capture.screenshot.height} px · ${inspectedItem.capture.screenshot.path}` : inspectedItem.capture.screenshot.status === "pending" ? "Capturing…" : `Unavailable · ${inspectedItem.capture.screenshot.reason ?? "unknown reason"}`}</dd>
        </dl>
        <details><summary>Bounded DOM and styles</summary><pre>{inspectedItem.capture.element.html}</pre><pre>{JSON.stringify(inspectedItem.capture.computedStyles, null, 2)}</pre></details>
        <small>Screenshot pixels may contain visible private information. Inspect or remove this attachment before sending.</small>
      </section>}
      <div className="conversation" role="log" aria-label="Demo conversation"><p>{messages.length ? `You: ${messages.at(-1)}` : "Explore both previews, then leave a note about what you’d like to change."}</p>{messages.length > 0 && <p>Demo: Your note stays here. No project files were changed.</p>}{sendError && <p className="send-error">{sendError}</p>}</div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" placeholder="Describe a change…" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" disabled={!draft.trim() || sending}>{sending ? "Checking…" : "Send demo"}</button>
      </form>
    </div>
  </footer>;
}
