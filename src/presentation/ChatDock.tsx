import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Settings2 } from "lucide-react";
import type { AgentChangeSetView, AgentDialog, AgentSnapshot } from "../application/agent-contract";
import type { StoredSelection } from "../application/selection-state";
import { SelectionComposer } from "./SelectionComposer";

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const EMPTY_AGENT: AgentSnapshot = {
  ready: false, workspaceId: "", providers: [], models: [], sessions: [], messages: [], tools: [], changeSets: [],
  thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Connecting to bundled pi SDK…",
};

function useModalFocus(onClose: () => void, trap = true) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    if (!element) return;
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab" || !trap) return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    element.addEventListener("keydown", keydown);
    return () => { element.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return ref;
}

function AgentPromptDialog({ workspaceId, dialog, onClose }: { workspaceId: string; dialog: AgentDialog; onClose: () => void }) {
  const [value, setValue] = useState("");
  const blocking = dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code" || dialog.kind === "select" || dialog.kind === "approval" || ((dialog.kind === "info" || dialog.kind === "progress") && !!dialog.cancellable);
  async function answer(cancelled: boolean, responseValue = value) {
    if (blocking && window.mauxi) await window.mauxi.agentDialogResponse({ workspaceId, dialogId: dialog.id, value: cancelled ? undefined : responseValue, cancelled });
    onClose();
  }
  const browserApproval = dialog.kind === "approval" && dialog.title === "Approve browser action";
  const focusRef = useModalFocus(() => void answer(true), !browserApproval);
  return <div className={`agent-dialog-backdrop ${browserApproval ? "browser-approval" : ""}`} role="presentation">
    <section ref={focusRef} className="agent-dialog" role="dialog" aria-modal={!browserApproval} aria-labelledby={`dialog-${dialog.id}`}>
      <header><h2 id={`dialog-${dialog.id}`}>{dialog.title}</h2>{!blocking && <button aria-label="Close" onClick={onClose}>×</button>}</header>
      <p>{dialog.message}</p>
      {dialog.kind === "select" && <div className="dialog-options">{dialog.options.map((option) => <button key={option.id} onClick={() => setValue(option.id)} aria-pressed={value === option.id}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>}
      {(dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code") && <input autoFocus type={dialog.kind === "secret" ? "password" : "text"} autoComplete="off" placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value) void answer(false); }} />}
      {dialog.kind === "approval" && <section className="approval-detail"><strong>Exact operation</strong><pre>{dialog.operation}</pre>{dialog.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}</section>}
      {"links" in dialog && dialog.links?.map((link) => <button className="auth-link" key={link.url} onClick={() => void window.mauxi?.openAuthUrl(link.url)}>{link.label ?? "Open in browser"}</button>)}
      {dialog.kind === "approval" ? <footer><button onClick={() => void answer(true)}>Deny</button><button className="primary" onClick={() => void answer(false, "approve")}>Approve once</button></footer> : blocking && <footer><button onClick={() => void answer(true)}>Cancel</button>{dialog.kind !== "info" && dialog.kind !== "progress" && <button className="primary" disabled={!value} onClick={() => void answer(false)}>Continue</button>}</footer>}
    </section>
  </div>;
}

function AgentSettings({ agent, workspaceId, busy, run, onClose, onInvoke, error }: {
  agent: AgentSnapshot; workspaceId: string; busy: boolean; run: (action: () => Promise<unknown>) => void; onClose: () => void; onInvoke: (name: string) => void; error?: string;
}) {
  const selected = agent.models.find((model) => model.key === agent.selectedModel);
  const [rename, setRename] = useState(agent.sessionName ?? "");
  const focusRef = useModalFocus(onClose);
  const resourceBusy = busy || !["idle", "error"].includes(agent.runState);
  return <div className="agent-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={focusRef} className="agent-settings" role="dialog" aria-modal="true" aria-label="Agent settings">
      <header><div><span className="eyebrow">MAUXI</span><h2>Agent settings</h2></div><button aria-label="Close settings" onClick={onClose}>×</button></header>
      {error && <p className="send-error" role="alert">{error}</p>}
      <label><span>Model</span><select value={agent.selectedModel ?? ""} disabled={busy} onChange={(event) => run(() => window.mauxi!.agentSelectModel({ workspaceId, modelKey: event.target.value }))}>
        <option value="">Choose an authenticated model…</option>
        {agent.models.map((model) => <option key={model.key} value={model.key} disabled={!model.available}>{model.provider} · {model.name}{model.supportsImages ? " · images" : " · text only"}{model.available ? "" : " · sign in"}</option>)}
      </select></label>
      <label><span>Thinking</span><select value={agent.thinkingLevel} disabled={!selected || busy} onChange={(event) => run(() => window.mauxi!.agentSetThinking({ workspaceId, level: event.target.value as AgentSnapshot["thinkingLevel"] }))}>
        {(selected?.thinkingLevels ?? ["off"]).map((level) => <option value={level} key={level}>{level}</option>)}
      </select></label>
      <details className="resource-settings"><summary><strong>Design guidance</strong><span>{agent.resources?.skills.filter((skill) => skill.loaded).length ?? 0} enabled</span></summary>
        <p>Local guidance, matched to your request. Your terminal setup stays untouched.</p>
        <div className="resource-actions"><button disabled={resourceBusy} onClick={() => run(() => window.mauxi!.agentImportResource({ workspaceId, kind: "skill" }))}>Import skill…</button><button disabled={resourceBusy} onClick={() => run(() => window.mauxi!.agentImportResource({ workspaceId, kind: "catalog" }))}>Choose visual library…</button></div>
        {!agent.resources?.skills.length && <p className="resource-hint">Choose SKILL.md for apple-design, mobile-native, emil-design-eng or prototype. Review local content before approving.</p>}
        {agent.resources?.skills.map((skill) => <article className="resource-row" key={skill.name}><label><input type="checkbox" checked={skill.enabled} disabled={resourceBusy} onChange={(event) => run(() => window.mauxi!.agentToggleResource({ workspaceId, name: skill.name, enabled: event.target.checked }))} /><span><strong>{skill.name}</strong><small>{skill.error ? "Needs attention" : skill.loaded ? "Ready · automatic" : "Disabled"}</small></span></label><button disabled={resourceBusy || !skill.loaded} onClick={() => onInvoke(skill.name)}>Use once</button><details><summary>Local source & version</summary><code>{skill.source}</code><small>SHA-256 · {skill.digest}</small><p>{skill.description}</p><small>Local-only import · redistribution not approved</small></details>{skill.error && <p role="alert" className="send-error">{skill.error}</p>}</article>)}
        {agent.resources?.catalog && <article className="resource-row"><label><input type="checkbox" checked={agent.resources.catalog.enabled} disabled={resourceBusy} onChange={(event) => run(() => window.mauxi!.agentToggleResource({ workspaceId, name: "catalog", enabled: event.target.checked }))} /><span><strong>Visual library</strong><small>{agent.resources.catalog.count} reviewed entries</small></span></label><code>{agent.resources.catalog.path}</code>{agent.resources.catalog.error && <p role="alert" className="send-error">{agent.resources.catalog.error}</p>}</article>}
        {agent.resources?.diagnostics.map((message) => <p className="send-error" role="alert" key={message}>{message}</p>)}
        <details className="resource-hint"><summary>Tools & limits</summary><p>Host-owned tools: {agent.resources?.tools.join(", ") || "No guidance tools connected"}. Project reads and checkpointed writes are host-owned; commands and installs always need approval.</p><p>Executable extensions, package imports and terminal-only UI are unsupported. No code is loaded by importing Markdown. Disabled guidance can remain in conversation history; start a new conversation to remove that context.</p></details>
      </details>
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

export function ChangeReview({ changeSets, idle, onUndo }: { changeSets: AgentChangeSetView[]; idle: boolean; onUndo: (id: string) => void }) {
  const latest = changeSets.find((set) => set.files.length || set.unexpectedPaths.length || set.errors.length || set.coverageWarnings.length);
  const eligible = changeSets.find((set) => set.undoEligible);
  // Keep the latest review visible, but expose the actual backend-eligible target
  // separately (including its files), rather than mislabeling the newest record.
  const displayed = latest ? [latest, ...(eligible && eligible.id !== latest.id ? [eligible] : [])] : [];
  return <>{displayed.map((set) => <details className={`change-review ${set.state}`} key={set.id}>
    <summary><span><strong>{set === latest ? "Changes" : "Undo target"} · {set.label}</strong><small>{set.files.length} file{set.files.length === 1 ? "" : "s"} · {set.state}</small></span>{idle && eligible?.id === set.id && <button type="button" onClick={(event) => { event.preventDefault(); onUndo(set.id); }}>Undo · {set.label}</button>}</summary>
    {set.coverageWarnings.map((warning) => <p className="coverage-warning" key={warning}>{warning}</p>)}
    {set.files.map((file) => <details className="changed-file" key={file.path}><summary><span className={`change-kind ${file.kind === "create" ? "create" : "modify"}`}>{file.kind}</span><code>{file.path}</code><small>{file.attribution === "unattributed" ? "unattributed command observation" : "agent edit"}</small></summary><pre>{file.diff}</pre></details>)}
    {set.unexpectedPaths.length > 0 && <details><summary>Unattributable command changes · {set.unexpectedPaths.length}</summary><ul>{set.unexpectedPaths.map((item) => <li key={item}><code>{item}</code></li>)}</ul></details>}
    {set.errors.map((error) => <p className="send-error" key={error}>{error}</p>)}
  </details>)}</>;
}

export function ChatDock({ workspaceId, selections, onRemove, onBeforeSend, onSelectionsSent }: {
  workspaceId?: string; selections: StoredSelection[];
  onRemove: (id: string) => void;
  onBeforeSend: () => Promise<{ ok: boolean; message?: string; selections?: StoredSelection[] }>;
  onSelectionsSent: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState<AgentSnapshot>(EMPTY_AGENT);
  const [dialog, setDialog] = useState<AgentDialog | null>(null);
  const [settings, setSettings] = useState(false);
  const [sendError, setSendError] = useState("");
  const [busy, setBusy] = useState(false);
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

  return <>
    <SelectionComposer selections={selections} onRemove={onRemove}>
      {(sendError || agent.error) && <p className="send-error" role="alert">{sendError || agent.error?.message}</p>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(running ? "followUp" : "prompt"); }}>
        <label className="sr-only" htmlFor="chat-message">Message</label>
        <textarea id="chat-message" placeholder={running ? "Add a follow-up…" : "Describe a change or ask about the interface…"} rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="composer-toolbar">
          <button className="model-picker" type="button" aria-label="Models & providers" aria-haspopup="dialog" disabled={!workspaceId} title={selectedModel ? `${selectedModel.provider} · ${selectedModel.name}` : "Models & providers"} onClick={() => setSettings(true)}>
            <Settings2 size={16} aria-hidden="true" /><span>{selectedModel ? selectedModel.name : "Models & providers"}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          <div className="send-actions">
            {running && <button type="button" className="stop-button" disabled={busy || agent.runState === "stopping"} onClick={() => run(() => window.mauxi!.agentStop(workspaceId!))}>Stop</button>}
            {running && <button type="button" className="composer-secondary" disabled={!draft.trim() || busy} title="Deliver after the current tool turn" onClick={() => void submit("steer")}>Steer</button>}
            <button className="primary" type="submit" disabled={!workspaceId || !draft.trim() || busy || !agent.selectedModel}><span>{busy ? "Checking…" : running ? "Follow up" : "Send"}</span><ArrowUpRight size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </form>
    </SelectionComposer>
    {settings && workspaceId && <AgentSettings agent={agent} workspaceId={workspaceId} error={sendError} busy={busy} run={run} onClose={() => setSettings(false)} onInvoke={(name) => { setDraft((current) => `/skill:${name} ${current.replace(/^\/(?:skill:)?[a-z-]+\s*/, "")}`); setSettings(false); requestAnimationFrame(() => document.getElementById("chat-message")?.focus()); }} />}
    {dialog && workspaceId && <AgentPromptDialog key={dialog.id} workspaceId={workspaceId} dialog={dialog} onClose={() => setDialog(null)} />}
  </>;
}
