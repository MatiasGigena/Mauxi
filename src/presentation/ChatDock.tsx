import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentDialog, AgentSnapshot } from "../application/agent-contract";
import type { StoredSelection } from "../application/selection-state";

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const EMPTY_AGENT: AgentSnapshot = {
  ready: false, workspaceId: "", providers: [], models: [], sessions: [], messages: [], tools: [],
  thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Connecting to bundled pi SDK…",
};

function AgentPromptDialog({ workspaceId, dialog, onClose }: { workspaceId: string; dialog: AgentDialog; onClose: () => void }) {
  const [value, setValue] = useState("");
  const blocking = dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code" || dialog.kind === "select" || ((dialog.kind === "info" || dialog.kind === "progress") && !!dialog.cancellable);
  async function answer(cancelled: boolean) {
    if (blocking && window.mauxi) await window.mauxi.agentDialogResponse({ workspaceId, dialogId: dialog.id, value: cancelled ? undefined : value, cancelled });
    onClose();
  }
  return <div className="agent-dialog-backdrop" role="presentation">
    <section className="agent-dialog" role="dialog" aria-modal="true" aria-labelledby={`dialog-${dialog.id}`}>
      <header><h2 id={`dialog-${dialog.id}`}>{dialog.title}</h2>{!blocking && <button aria-label="Close" onClick={onClose}>×</button>}</header>
      <p>{dialog.message}</p>
      {dialog.kind === "select" && <div className="dialog-options">{dialog.options.map((option) => <button key={option.id} onClick={() => setValue(option.id)} aria-pressed={value === option.id}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>}
      {(dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code") && <input autoFocus type={dialog.kind === "secret" ? "password" : "text"} autoComplete="off" placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value) void answer(false); }} />}
      {"links" in dialog && dialog.links?.map((link) => <button className="auth-link" key={link.url} onClick={() => void window.mauxi?.openAuthUrl(link.url)}>{link.label ?? "Open in browser"}</button>)}
      {blocking && <footer><button onClick={() => void answer(true)}>Cancel</button>{dialog.kind !== "info" && dialog.kind !== "progress" && <button className="primary" disabled={!value} onClick={() => void answer(false)}>Continue</button>}</footer>}
    </section>
  </div>;
}

function AgentSettings({ agent, workspaceId, busy, run, onClose }: {
  agent: AgentSnapshot; workspaceId: string; busy: boolean; run: (action: () => Promise<unknown>) => void; onClose: () => void;
}) {
  const selected = agent.models.find((model) => model.key === agent.selectedModel);
  const [rename, setRename] = useState(agent.sessionName ?? "");
  return <div className="agent-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="agent-settings" role="dialog" aria-modal="true" aria-label="Models and conversations">
      <header><div><span className="eyebrow">BUNDLED PI SDK</span><h2>Models & conversations</h2></div><button aria-label="Close settings" onClick={onClose}>×</button></header>
      <label><span>Model</span><select value={agent.selectedModel ?? ""} disabled={busy} onChange={(event) => run(() => window.mauxi!.agentSelectModel({ workspaceId, modelKey: event.target.value }))}>
        <option value="">Choose an authenticated model…</option>
        {agent.models.map((model) => <option key={model.key} value={model.key} disabled={!model.available}>{model.provider} · {model.name}{model.supportsImages ? " · images" : " · text only"}{model.available ? "" : " · sign in"}</option>)}
      </select></label>
      <label><span>Thinking</span><select value={agent.thinkingLevel} disabled={!selected || busy} onChange={(event) => run(() => window.mauxi!.agentSetThinking({ workspaceId, level: event.target.value as AgentSnapshot["thinkingLevel"] }))}>
        {(selected?.thinkingLevels ?? ["off"]).map((level) => <option value={level} key={level}>{level}</option>)}
      </select></label>
      <section className="provider-list"><div className="section-heading"><strong>Providers</strong><button disabled={busy} onClick={() => run(() => window.mauxi!.agentRefreshCatalog(workspaceId))}>Refresh catalog</button></div>
        {agent.providers.map((provider) => <article key={provider.id}><div><strong>{provider.name}</strong><span>{provider.authenticated ? `Connected${provider.authSource ? ` · ${provider.authSource}` : ""}` : "Not connected"}</span></div><div>
          {provider.authenticated && <button disabled={busy} onClick={() => run(() => window.mauxi!.agentLogout({ workspaceId, providerId: provider.id }))}>Log out</button>}
          {provider.authMethods.map((method) => <button className={provider.authenticated ? "" : "primary"} disabled={busy} key={method.type} onClick={() => run(() => window.mauxi!.agentLogin({ workspaceId, providerId: provider.id, type: method.type }))}>{provider.authenticated ? "Re-authenticate" : method.label}</button>)}
        </div></article>)}
      </section>
      <section className="session-list"><div className="section-heading"><strong>Conversations</strong><button disabled={busy || agent.runState !== "idle"} onClick={() => run(() => window.mauxi!.agentNewSession(workspaceId))}>New</button></div>
        <div className="rename-row"><input aria-label="Conversation name" value={rename} maxLength={120} placeholder="Name this conversation" onChange={(event) => setRename(event.target.value)} /><button disabled={busy || !rename.trim()} onClick={() => run(() => window.mauxi!.agentRenameSession({ workspaceId, name: rename }))}>Rename</button></div>
        {agent.sessions.map((session) => <button className="session-row" disabled={busy || session.active || agent.runState !== "idle"} key={session.id} onClick={() => run(() => window.mauxi!.agentResumeSession({ workspaceId, sessionId: session.id }))}><strong>{session.name || session.firstMessage || "Empty conversation"}</strong><span>{session.active ? "Current" : new Date(session.updatedAt).toLocaleString()}</span></button>)}
        <small>Resuming conversation history never restores project files.</small>
      </section>
      <p className="privacy-note">Provider credentials stay in Mauxi’s private pi profile. They are never returned to this window or stored in chat.</p>
    </section>
  </div>;
}

export function ChatDock({ height, onResize, workspaceId, selections, onRemove, onRevalidate, onBeforeSend, onSelectionsSent }: {
  height: number; onResize: (height: number) => void; workspaceId?: string; selections: StoredSelection[];
  onRemove: (id: string) => void; onRevalidate: (item: StoredSelection) => void;
  onBeforeSend: () => Promise<{ ok: boolean; message?: string; selections?: StoredSelection[] }>;
  onSelectionsSent: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState<AgentSnapshot>(EMPTY_AGENT);
  const [dialog, setDialog] = useState<AgentDialog | null>(null);
  const [settings, setSettings] = useState(false);
  const [inspected, setInspected] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const inspectedItem = selections.find((item) => item.capture.selectionId === inspected);
  const running = agent.runState !== "idle" && agent.runState !== "error";
  const selectedModel = agent.models.find((model) => model.key === agent.selectedModel);

  useEffect(() => {
    if (!workspaceId || !window.mauxi) return;
    let live = true;
    const off = window.mauxi.onAgentEvent((event) => {
      if (!live) return;
      if (event.type === "snapshot" && event.snapshot.workspaceId === workspaceId) setAgent(event.snapshot);
      if (event.type === "dialog") setDialog(event.dialog);
      if (event.type === "dialog-dismissed") setDialog((current) => current?.id === event.id ? null : current);
    });
    void window.mauxi.agentBootstrap().then((snapshot) => { if (live) setAgent(snapshot); }).catch((error) => { if (live) setSendError(errorMessage(error)); });
    return () => { live = false; off(); };
  }, [workspaceId]);

  function run(action: () => Promise<unknown>) {
    setBusy(true); setSendError("");
    void action().catch((error) => setSendError(errorMessage(error))).finally(() => setBusy(false));
  }

  async function submit(behavior: "prompt" | "steer" | "followUp") {
    if (!workspaceId || !window.mauxi || !draft.trim() || busy) return;
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    setBusy(true); setSendError("");
    try {
      const result = await onBeforeSend();
      if (!result.ok) { setSendError(result.message ?? "Attached context must be refreshed before sending."); return; }
      const attached = result.selections ?? [];
      const response = await window.mauxi.agentSend({ workspaceId, text, behavior, selections: attached });
      if (!response.accepted) { setSendError("The request was not accepted. Your draft and attachments were kept."); return; }
      // Sending is asynchronous and the composer remains editable. Clear only
      // the exact draft that was accepted; preserve text typed for the next turn.
      setDraft((current) => current === submittedDraft ? "" : current);
      onSelectionsSent(attached.map((item) => item.capture.selectionId));
    } catch (error) { setSendError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  const status = !workspaceId ? "Open a project to connect pi" : agent.status;
  return <footer className="chat-dock" aria-label="Chat" style={{ height }}>
    <div className="dock-resizer" role="separator" tabIndex={0} aria-label="Resize chat" aria-orientation="horizontal" aria-valuemin={144} aria-valuemax={600} aria-valuenow={Math.round(height)}
      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height }; }}
      onPointerMove={(event) => { if (drag.current) onResize(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); onResize(event.key === "Home" ? 144 : event.key === "End" ? 600 : height + (event.key === "ArrowUp" ? 24 : -24)); } }}><span /></div>
    <div className="chat-content">
      <div className="dock-heading"><div><strong>{agent.sessionName || "Conversation"}</strong><span className={`agent-state ${agent.runState}`}>{status}</span></div><div className="dock-controls">{running && <button className="stop-button" disabled={agent.runState === "stopping"} onClick={() => run(() => window.mauxi!.agentStop(workspaceId!))}>Stop</button>}<button disabled={!workspaceId} onClick={() => setSettings(true)}>{selectedModel ? `${selectedModel.provider} · ${selectedModel.name}` : "Models & providers"}</button></div></div>
      {selections.length > 0 && <div className="selection-list" data-testid="selection-list">{selections.map((item) => {
        const source = item.capture.source;
        const sourceLabel = source.verification === "verified" ? `${source.filePath.split(/[\\/]/).slice(-2).join("/")}:${source.lineNumber ?? "?"}` : source.verification === "library" ? "Library source" : source.filePath ? `Source ambiguous (${source.filePath}:${source.lineNumber ?? "?"}:${source.columnNumber ?? "?"})` : "Source unresolved";
        return <article className={`selection-chip ${item.status}`} key={item.capture.selectionId}><span className="preview-pill">{item.capture.previewId}</span><strong>{item.capture.element.label}</strong><code title={source.verification === "verified" ? source.filePath : undefined}>{sourceLabel}</code><span>{item.status === "stale" ? "Stale" : source.verification === "verified" ? `${source.method} · verified JSX` : source.verification}</span>{item.capture.support.status === "unsupported" && <span className="unsupported">Unsupported source</span>}<button aria-expanded={inspected === item.capture.selectionId} onClick={() => setInspected(inspected === item.capture.selectionId ? null : item.capture.selectionId)}>Inspect</button><button disabled={item.requiresRepick} title={item.staleReason} onClick={() => onRevalidate(item)}>{item.requiresRepick ? "Pick again" : "Revalidate"}</button><button aria-label={`Remove selection ${item.capture.element.label}`} onClick={() => { onRemove(item.capture.selectionId); if (inspected === item.capture.selectionId) setInspected(null); }}>×</button></article>;
      })}</div>}
      {inspectedItem && <section className="selection-inspector" aria-label={`Selection details for ${inspectedItem.capture.element.label}`}><header><strong>{inspectedItem.capture.element.label}</strong><span>{inspectedItem.status === "current" ? "Live capture" : "Historical · stale"}</span></header>{inspectedItem.capture.support.reason && <p className="selection-warning">{inspectedItem.capture.support.reason}</p>}<dl><dt>Workspace / preview</dt><dd>{inspectedItem.capture.workspaceId} · {inspectedItem.capture.previewId}</dd><dt>Route</dt><dd>{inspectedItem.capture.url}</dd><dt>Captured</dt><dd>{inspectedItem.capture.capturedAt} · generation {inspectedItem.capture.documentGeneration.slice(0, 8)}</dd><dt>Viewport / bounds</dt><dd>{inspectedItem.capture.viewport.width}×{inspectedItem.capture.viewport.height} CSS px · {Math.round(inspectedItem.capture.bounds.x)},{Math.round(inspectedItem.capture.bounds.y)} {Math.round(inspectedItem.capture.bounds.width)}×{Math.round(inspectedItem.capture.bounds.height)}</dd><dt>Bounded text</dt><dd>{inspectedItem.capture.element.text || "None"}</dd><dt>JSX provenance</dt><dd>{inspectedItem.capture.source.verification === "verified" ? `${inspectedItem.capture.source.filePath}:${inspectedItem.capture.source.lineNumber ?? "?"}:${inspectedItem.capture.source.columnNumber ?? "?"} · SHA-256 ${inspectedItem.capture.source.fileFingerprint}` : `${inspectedItem.capture.source.verification} · ${inspectedItem.capture.source.filePath || "No source location"}`}</dd><dt>Screenshot crop</dt><dd>{inspectedItem.capture.screenshot.status === "captured" ? `${inspectedItem.capture.screenshot.width}×${inspectedItem.capture.screenshot.height} px · attached to the next request` : inspectedItem.capture.screenshot.status === "pending" ? "Capturing…" : `Unavailable · ${inspectedItem.capture.screenshot.reason ?? "unknown reason"}`}</dd></dl><details><summary>Bounded DOM and styles</summary><pre>{inspectedItem.capture.element.html}</pre><pre>{JSON.stringify(inspectedItem.capture.computedStyles, null, 2)}</pre></details><small>Screenshot pixels may contain visible private information. Inspect or remove this attachment before sending.</small></section>}
      <div className="conversation" role="log" aria-label="Conversation" aria-live="polite">{!agent.messages.length && <p className="empty-conversation">Explore both previews, attach precise targets, then describe what you want to understand.</p>}{agent.messages.map((message) => <article className={`chat-message ${message.role} ${message.error ? "error" : ""}`} key={message.id}><strong>{message.role === "user" ? "You" : "Mauxi"}</strong><p>{message.text}</p></article>)}{agent.tools.length > 0 && <details className="tool-activity" open={agent.tools.some((tool) => tool.status === "running")}><summary>Tool activity · {agent.tools.filter((tool) => tool.status === "running").length ? "working" : `${agent.tools.length} completed`}</summary>{agent.tools.map((tool) => <details key={tool.id}><summary><span className={`tool-status ${tool.status}`} />{tool.name}</summary>{tool.input && <><small>Input</small><pre>{tool.input}</pre></>}{tool.output && <><small>Output</small><pre>{tool.output}</pre></>}</details>)}</details>}{agent.queued.steering + agent.queued.followUp > 0 && <p className="queue-status">Queued · {agent.queued.steering} steering · {agent.queued.followUp} follow-up</p>}{(sendError || agent.error) && <p className="send-error" role="alert">{sendError || agent.error?.message}</p>}</div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(running ? "followUp" : "prompt"); }}><label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" placeholder={running ? "Add a follow-up…" : "Describe a change or ask about the interface…"} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="send-actions">{running && <button type="button" disabled={!draft.trim() || busy} title="Deliver after the current tool turn" onClick={() => void submit("steer")}>Steer</button>}<button type="submit" disabled={!workspaceId || !draft.trim() || busy || !agent.selectedModel}>{busy ? "Checking…" : running ? "Follow up" : "Send"}</button></div></form>
    </div>
    {settings && workspaceId && <AgentSettings agent={agent} workspaceId={workspaceId} busy={busy} run={run} onClose={() => setSettings(false)} />}
    {dialog && workspaceId && <AgentPromptDialog workspaceId={workspaceId} dialog={dialog} onClose={() => setDialog(null)} />}
  </footer>;
}
