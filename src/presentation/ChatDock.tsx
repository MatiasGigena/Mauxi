import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, RefreshCw, Settings2, ScanEye, Hand, TriangleAlert, X } from "lucide-react";
import type { AgentDialog, AgentSnapshot } from "../application/agent-contract";
import type { StoredSelection } from "../application/selection-state";
import { SelectionComposer } from "./SelectionComposer";
import { ChatExchange, exchangeContainsError, latestExchange, type AcceptedPrompt } from "./ChatExchange";
import { ComposerAction } from "./ComposerAction";

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

const EMPTY_AGENT: AgentSnapshot = {
  ready: false, workspaceId: "", providers: [], models: [], messages: [],
  thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Connecting to bundled pi SDK…",
};

function useModalFocus(onClose: () => void, trap = true, active = true) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const focused = document.activeElement;
    const previous = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null;
    const element = ref.current;

    if (!active || !element) return;
    const focusable = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
    (focusable()[0] ?? element).focus({ preventScroll: true });

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }

      if (event.key !== "Tab" || !trap) return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);

      if (!first) { event.preventDefault();

      return; }

      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };

    element.addEventListener("keydown", keydown);

    return () => {
      element.removeEventListener("keydown", keydown);

      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    };
  }, [active]);

  return ref;
}

function AgentPromptDialog({ workspaceId, dialog, onClose, inline = false, active = true, providerLogin = false }: { workspaceId: string; dialog: AgentDialog; onClose: () => void; inline?: boolean; active?: boolean; providerLogin?: boolean }) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const answering = useRef(false);
  useEffect(() => { if (!active) setValue(""); }, [active]);
  const blocking = dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code" || dialog.kind === "select" || dialog.kind === "approval" || ((dialog.kind === "info" || dialog.kind === "progress") && !!dialog.cancellable);

  async function answer(cancelled: boolean, responseValue = value) {
    if (!active || answering.current) return;
    answering.current = true; setPending(true); setError("");

    try {
      if (blocking && window.mauxi) await window.mauxi.agentDialogResponse({ workspaceId, dialogId: dialog.id, value: cancelled ? undefined : responseValue, cancelled });
      setValue("");
      onClose();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { answering.current = false; setPending(false); }
  }

  const browserApproval = dialog.kind === "approval" && dialog.title === "Approve browser action";
  const focusRef = useModalFocus(() => void answer(true), !inline && !browserApproval, active);

  return <div className={inline ? "agent-dialog-inline" : `agent-dialog-backdrop ${browserApproval ? "browser-approval" : ""}`} role="presentation">
    <section ref={focusRef} className={`agent-dialog${dialog.kind === "approval" ? " action-modal permission-dialog" : ""}`} tabIndex={-1} role="dialog" aria-modal={!inline && !browserApproval} aria-labelledby={`dialog-${dialog.id}`}>
      <header><h2 id={`dialog-${dialog.id}`}>{dialog.title}</h2>{dialog.kind === "approval" ? <button type="button" className="action-modal-close" aria-label="Deny and close" disabled={pending} onClick={() => void answer(true)}><X size={18} aria-hidden="true" /></button> : !blocking && <button aria-label="Close" onClick={onClose}>×</button>}</header>
      {!(inline && dialog.kind === "select" && (providerLogin || dialog.message.trim() === `Sign in to ${dialog.title}:`)) && <p>{dialog.message}</p>}
      {(error || dialog.warning) && <p className="send-error" role="alert">{error || dialog.warning}</p>}
      {dialog.kind === "select" && <div className="dialog-options" role="group" aria-label={dialog.message}>{dialog.options.map((option) => <button type="button" className={inline ? "settings-action login-option" : undefined} key={option.id} disabled={pending} onClick={() => setValue(option.id)} aria-pressed={value === option.id}>
        {inline ? <><span>{option.label}</span>{value === option.id ? <Check size={14} aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}{option.description && <small>{option.description}</small>}</> : <><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</>}
      </button>)}</div>}
      {(dialog.kind === "text" || dialog.kind === "secret" || dialog.kind === "manual_code") && <input aria-label={dialog.message} readOnly={pending} type={dialog.kind === "secret" ? "password" : "text"} autoComplete="off" placeholder={dialog.placeholder} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && value) { event.preventDefault(); void answer(false); } }} />}
      {dialog.kind === "approval" && <section className="approval-detail"><strong>Exact operation</strong><pre tabIndex={0} aria-label="Exact operation">{dialog.operation}</pre><ul className="approval-warnings">{dialog.warnings.map((warning) => <li key={warning}><TriangleAlert size={15} aria-hidden="true" /><span>{warning}</span></li>)}</ul></section>}
      {"links" in dialog && dialog.links?.map((link) => <button className={inline ? "settings-action" : "auth-link"} key={link.url} onClick={() => { setError(""); void window.mauxi?.openAuthUrl(link.url).catch(() => setError("Could not open your default browser. Check your system browser settings and try again.")); }}><span>{link.label ?? "Open in browser"}</span>{inline && <ArrowUpRight size={12} aria-hidden="true" />}</button>)}
      {dialog.kind === "approval" ? <footer className="confirmation-actions"><button type="button" className="action-modal-secondary" disabled={pending} onClick={() => void answer(true)}>Deny</button><button type="button" className="primary" disabled={pending} onClick={() => void answer(false, "approve")}><span>Approve once</span><ArrowUpRight size={16} aria-hidden="true" /></button></footer> : blocking && <footer className={inline ? "confirmation-actions" : undefined}><button className={inline ? "change-project" : undefined} disabled={pending} onClick={() => void answer(true)}>Cancel</button>{dialog.kind !== "info" && dialog.kind !== "progress" && <button className="primary" disabled={!value || pending} onClick={() => void answer(false)}><span>{pending ? "Continuing…" : "Continue"}</span>{inline && <ArrowUpRight size={16} aria-hidden="true" />}</button>}</footer>}
    </section>
  </div>;
}

function ModelSelect({ agent, busy, onSelect, children }: {
  agent: AgentSnapshot; busy: boolean; onSelect: (key: string) => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const activeFromPointer = useRef(false);
  const typeahead = useRef({ text: "", time: 0 });
  const selected = agent.models.find(model => model.key === agent.selectedModel);
  const available = agent.models.filter(model => model.available);
  const providerName = (provider: string) => agent.providers.find(item => item.id === provider)?.name ?? provider;
  const matching = available.filter(model => `${model.name} ${model.id} ${providerName(model.provider)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = [...new Set(matching.map(model => model.provider))].sort((a, b) => providerName(a).localeCompare(providerName(b)));
  const options = groups.flatMap(provider => matching.filter(model => model.provider === provider));
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  function setExpanded(next: boolean, fromKeyboard: boolean) {
    if (next && !available.length) return;
    setOpen(next); setKeyboard(fromKeyboard);

    if (next) { activeFromPointer.current = false; setQuery(""); setActive(Math.max(0, options.findIndex(model => model.key === agent.selectedModel))); typeahead.current = { text: "", time: 0 }; }
    else setQuery("");
  }

  function choose(key: string) {
    if (busy) return;
    setExpanded(false, keyboard); onSelect(key);
    trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target instanceof Node ? event.target : null)) setExpanded(false, false); };

    document.addEventListener("pointerdown", outside);

    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    const option = document.getElementById(`${id}-option-${activeIndex}`);

    if (!open || activeFromPointer.current || !option || !list.current) return;
    const item = option.getBoundingClientRect(); const bounds = list.current.getBoundingClientRect();

    if (item.top < bounds.top) list.current.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.current.scrollTop += item.bottom - bounds.bottom;
  }, [open, activeIndex, query, id]);

  function keys(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (busy || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setExpanded(false, true);

    return; }

    if (event.key === "Tab") { if (open) setExpanded(false, true);

    return; }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      activeFromPointer.current = false;

      if (!open) setExpanded(true, true);
      else if (options.length) setActive((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopPropagation();

      if (options.length) choose(options[activeIndex].key);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); event.stopPropagation();
      activeFromPointer.current = false;

      if (!open) setExpanded(true, true);
      else setActive(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault(); event.stopPropagation();
      activeFromPointer.current = false;
      const now = Date.now();
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : "") + event.key.toLowerCase();
      const prefix = [...text].every(char => char === text[0]) ? text[0] : text;
      const candidates = options.map((_, offset) => (activeIndex + offset + 1) % options.length);
      const index = candidates.find(index => options[index].name.toLowerCase().startsWith(prefix) || options[index].id.toLowerCase().startsWith(prefix));

      if (!open) setExpanded(true, true);
      else if (index !== undefined) setActive(index);
      typeahead.current = { text, time: now };
    }
  }

  return <div ref={root} className="script-control model-select" data-keyboard={keyboard} onBlur={event => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) setExpanded(false, keyboard);
  }}>
    <button ref={trigger} type="button" className="script-select-trigger" role="combobox" disabled={!available.length || busy}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-label="Model" aria-activedescendant={open && options.length ? `${id}-option-${activeIndex}` : undefined}
      onKeyDown={keys} onClick={event => setExpanded(!open, event.detail === 0)}>
      <span id={`${id}-value`}>{selected ? `${providerName(selected.provider)} · ${selected.name}` : "Choose a model"}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    <div className="model-select-content">
    {open && <div className="script-select-popup">
      <input className="model-search" type="search" aria-label="Search models" placeholder="Search models or providers…" value={query} onChange={event => { activeFromPointer.current = false; setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false, true); trigger.current?.focus({ preventScroll: true }); }

        if (event.key === "ArrowDown" && options.length) { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); setActive(0); }
      }} />
      <div ref={list} className="script-select-options model-options" id={`${id}-list`} role="listbox" aria-label="Model">
        {groups.map(provider => <div className="model-group" key={provider}>
          <h3>{providerName(provider)}</h3>
          {options.map((model, index) => model.provider === provider && <div role="option" id={`${id}-option-${index}`} className="script-select-option model-option" key={model.key}
            aria-selected={model.key === agent.selectedModel} aria-label={`${model.name} (${providerName(provider)})`} data-active={index === activeIndex}
            onPointerMove={event => { if (event.pointerType === "mouse") { activeFromPointer.current = true; setActive(index); } }} onMouseDown={event => event.preventDefault()} onClick={() => choose(model.key)}>
            <span className="model-name"><strong>{model.name}</strong><small>{model.id}</small></span>
            <span className="model-capability">{model.supportsImages ? "Image support" : "Text only"}</span>
            {model.key === agent.selectedModel && <Check size={15} aria-hidden="true" />}
          </div>)}
        </div>)}
        {!options.length && <p className="settings-hint" role="status">No models match “{query.trim()}”.</p>}
      </div>
    </div>}
    <div className="model-details select-details" data-selector-open={open} data-selector-keyboard={keyboard} aria-hidden={open} inert={open}>
      {children}
    </div>
    </div>
    {!available.length && <p className="settings-hint">Connect a provider to choose a model.</p>}
  </div>;
}

function ProviderScroller({ count, children }: { count: number; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const thumbNode = useRef<HTMLDivElement>(null);
  const drag = useRef<{ offset: number } | null>(null);
  const [thumb, setThumb] = useState({ height: 0, top: 0, visible: false });

  function sync() {
    const node = viewport.current;

    if (!node) return;
    const { clientHeight, scrollHeight, scrollTop } = node;
    const visible = scrollHeight > clientHeight + 1;
    const height = visible ? Math.min(clientHeight, Math.max(96, clientHeight * clientHeight / scrollHeight)) : 0;
    const top = visible ? scrollTop / (scrollHeight - clientHeight) * (clientHeight - height) : 0;
    setThumb({ height, top, visible });
  }

  useLayoutEffect(() => {
    const observer = new ResizeObserver(sync);
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    sync();

    return () => observer.disconnect();
  }, []);

  function scrollToPointer(clientY: number, offset: number) {
    const node = viewport.current;
    const bar = track.current;

    if (!node || !bar) return;
    const travel = bar.clientHeight - thumb.height;

    if (travel <= 0) return;
    const position = Math.max(0, Math.min(travel, clientY - bar.getBoundingClientRect().top - offset));
    node.scrollTop = position / travel * (node.scrollHeight - node.clientHeight);
  }

  return <div className="provider-scroll">
    <div ref={viewport} className="provider-entries" role="region" aria-label="Provider list" tabIndex={count > 4 ? 0 : undefined} onScroll={sync}>
      <div ref={content} className="provider-rows">{children}</div>
    </div>
    {thumb.visible && <div ref={track} className="provider-scrollbar" aria-hidden="true" onPointerDown={event => {
      event.preventDefault();
      const offset = thumbNode.current?.contains(event.target instanceof Node ? event.target : null) ? event.clientY - thumbNode.current.getBoundingClientRect().top : thumb.height / 2;
      drag.current = { offset };
      event.currentTarget.setPointerCapture(event.pointerId);
      scrollToPointer(event.clientY, offset);
    }} onPointerMove={event => { if (drag.current) scrollToPointer(event.clientY, drag.current.offset); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <div ref={thumbNode} className="provider-scrollbar-thumb" style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }} />
    </div>}
  </div>;
}

function AgentSettings({ agent, workspaceId, busy, run, login, onClose }: {
  agent: AgentSnapshot; workspaceId: string; busy: boolean; run: (action: () => Promise<void>) => void; login: (action: () => Promise<void>, trigger: HTMLElement) => void; onClose: () => void;
}) {
  const selected = agent.models.find((model) => model.key === agent.selectedModel);

  return <section className="chat-settings" aria-label="Models and providers">
      <header><strong>Models & providers</strong><button type="button" aria-label="Close models and providers" onClick={onClose}>×</button></header>
      <ModelSelect agent={agent} busy={busy} onSelect={modelKey => run(async () => { await window.mauxi!.agentSelectModel({ workspaceId, modelKey }); onClose(); })}>
      {selected && <div className="thinking-options" role="group" aria-label="Thinking level"><span>Thinking</span>{selected.thinkingLevels.map((level) => <button className="settings-action thinking-option" type="button" key={level} aria-pressed={agent.thinkingLevel === level} disabled={busy} onClick={() => run(() => window.mauxi!.agentSetThinking({ workspaceId, level }))}><span>{level}</span></button>)}</div>}
      <section className="provider-list"><div className="section-heading"><strong>Providers</strong><button type="button" className="settings-action" disabled={busy} onClick={() => run(() => window.mauxi!.agentRefreshCatalog(workspaceId))}><span>Refresh catalog</span><RefreshCw size={12} aria-hidden="true" /></button></div>
        <ProviderScroller count={agent.providers.length}>
        {agent.providers.map(provider => <article key={provider.id}><div><strong>{provider.name}</strong><span>{provider.authenticated ? `Connected${provider.authSource ? ` · ${provider.authSource}` : ""}` : "Not connected"}</span></div><div>
          {provider.authenticated && <button type="button" className="settings-action" disabled={busy} onClick={() => run(() => window.mauxi!.agentLogout({ workspaceId, providerId: provider.id }))}><span>Log out</span><ArrowUpRight size={12} aria-hidden="true" /></button>}
          {provider.authMethods.map((method) => <button type="button" className="settings-action" disabled={busy} key={method.type} onClick={event => login(() => window.mauxi!.agentLogin({ workspaceId, providerId: provider.id, type: method.type }), event.currentTarget)}><span>{provider.authenticated ? "Re-authenticate" : method.label}</span><ArrowUpRight size={12} aria-hidden="true" /></button>)}
        </div></article>)}
        </ProviderScroller>
      </section>
      </ModelSelect>
    </section>;
}

export function ChatDock({ workspaceId, browserControl, minimizeRequest = 0, selections, onRemove, onBeforeSend, onSelectionsSent }: {
  workspaceId?: string; minimizeRequest?: number; selections: StoredSelection[];
  browserControl?: { ready: boolean; locked: boolean; pending: boolean; onGrant: () => void; onRevoke: () => void };
  onRemove: (id: string) => void;
  onBeforeSend: () => Promise<{ ok: boolean; message?: string; selections?: StoredSelection[] }>;
  onSelectionsSent: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [minimized, setMinimized] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!minimizeRequest) return;
    setMinimized(true);
    editor.current?.blur();
  }, [minimizeRequest]);
  const [agent, setAgent] = useState<AgentSnapshot>(EMPTY_AGENT);
  const [dialog, setDialog] = useState<AgentDialog | null>(null);
  const [settings, setSettings] = useState(false);
  const [sendError, setSendError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendingDraft, setSendingDraft] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [accepted, setAccepted] = useState<(AcceptedPrompt & { workspaceId: string; sessionId?: string }) | undefined>();
  const exchange = latestExchange(agent.messages, accepted && accepted.workspaceId === workspaceId && accepted.sessionId === agent.sessionId ? accepted : undefined);
  useEffect(() => {
    if (!accepted) return;

    if (accepted.workspaceId !== workspaceId || accepted.sessionId !== agent.sessionId || agent.messages.some(message => message.role === "user" && message.text === accepted.text && !accepted.previousUserIds.includes(message.id))) {
      setAccepted(undefined);
    }
  }, [accepted, workspaceId, agent.sessionId, agent.messages]);
  const running = agent.runState !== "idle" && agent.runState !== "error";
  const selectedModel = agent.models.find((model) => model.key === agent.selectedModel);
  const keyboardAction = useRef(false);
  const stopping = stopPending || agent.runState === "stopping";
  const working = running || sendingDraft !== null;
  const hasNewDraft = !!draft.trim() && draft !== sendingDraft;
  const stopAction = stopping || (working && !hasNewDraft);
  const action = stopping ? "stopping" : stopAction ? "stop" : working ? "followUp" : "send";
  const error = sendError || agent.error?.message || "";
  const showError = !!error && !exchangeContainsError(exchange, error);
  const inlineDialog = dialog?.kind !== "approval" ? dialog : null;
  const loginFocus = useRef<HTMLElement | null>(null);
  const providerLogin = loginFocus.current !== null;
  useLayoutEffect(() => {
    if (inlineDialog || busy || !loginFocus.current?.isConnected) return;
    let frame = 0;
    let attempts = 0;

    const restore = () => {
      const target = loginFocus.current;

      if (!target?.isConnected) return;

      if (!target.closest("[inert]") && getComputedStyle(target).visibility === "visible") {
        target.focus({ preventScroll: true });
        loginFocus.current = null;
      } else if (++attempts < 40) frame = requestAnimationFrame(restore);
    };

    frame = requestAnimationFrame(restore);

    return () => cancelAnimationFrame(frame);
  }, [inlineDialog, busy]);

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

  function run(action: () => Promise<void>) {
    setBusy(true); setSendError("");
    void action().catch((error) => setSendError(errorMessage(error))).finally(() => setBusy(false));
  }

  function login(action: () => Promise<void>, trigger: HTMLElement) {
    loginFocus.current = trigger;
    run(action);
  }

  function dismissDialog(id: string) {
    setDialog(current => current?.id === id ? null : current);
  }

  function stop() {
    if (!workspaceId || !window.mauxi || !running || busy || settings || inlineDialog || stopping) return;
    setStopPending(true);
    run(() => window.mauxi!.agentStop(workspaceId).finally(() => setStopPending(false)));
  }

  async function submit(behavior: "prompt" | "followUp") {
    if (!workspaceId || !window.mauxi || !agent.selectedModel || !draft.trim() || busy || settings || inlineDialog || stopping) return;
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    setMinimized(false); setSendingDraft(submittedDraft); setBusy(true); setSendError("");

    try {
      const result = await onBeforeSend();

      if (!result.ok) { setSendError(result.message ?? "Attached context must be refreshed before sending.");

      return; }

      const attached = result.selections ?? [];
      const previousUserIds = agent.messages.filter(message => message.role === "user").map(message => message.id);
      const response = await window.mauxi.agentSend({ workspaceId, text, behavior, selections: attached });

      if (!response.accepted) { setSendError("The request was not accepted. Your draft and attachments were kept.");

      return; }

      setAccepted({ text, previousUserIds, workspaceId, sessionId: agent.sessionId });
      setDraft((current) => current === submittedDraft ? "" : current);
      onSelectionsSent(attached.map((item) => item.capture.selectionId));
    } catch (error) { setSendError(errorMessage(error)); }
    finally { setSendingDraft(null); setBusy(false); }
  }

  return <>
    <SelectionComposer selections={selections} onRemove={onRemove} onActivate={() => setMinimized(false)} expansion={dialog?.id ?? ""}
      contentSize={JSON.stringify([draft, exchange, working, minimized, sendError, agent.error?.message])}
      panel={settings && workspaceId ? <AgentSettings agent={agent} workspaceId={workspaceId} busy={busy} run={run} login={login} onClose={() => setSettings(false)} /> : null}
      login={inlineDialog && workspaceId ? active => <AgentPromptDialog key={inlineDialog.id} workspaceId={workspaceId} dialog={inlineDialog} inline active={active} providerLogin={providerLogin} onClose={() => dismissDialog(inlineDialog.id)} /> : undefined}>
      {exchange && <ChatExchange exchange={exchange} running={running} hidden={minimized || settings || !!inlineDialog} />}
      {showError && <p className="send-error" role="alert" data-composer-motion="error" data-retained-motion="" data-exiting={minimized || undefined} inert={minimized} aria-hidden={minimized || undefined}>{error}</p>}
      <form className="composer" data-login={!!inlineDialog || undefined}
        onKeyDownCapture={() => { keyboardAction.current = true; }} onPointerDownCapture={() => { keyboardAction.current = false; }} onSubmit={(event) => { event.preventDefault(); void submit(running ? "followUp" : "prompt"); }}>
        <div className="composer-message" data-composer-motion="editor" data-retained-motion="" data-exiting={settings || !!inlineDialog || undefined} inert={settings || !!inlineDialog} aria-hidden={settings || !!inlineDialog || undefined}>
          <label className="sr-only" htmlFor="chat-message">Message</label>
          <textarea ref={editor} id="chat-message" placeholder={working ? "Add a follow-up…" : "Describe a change or ask about the interface…"} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();

              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }} />
        </div>
        <div className="composer-toolbar" data-composer-motion="toolbar" data-retained-motion="" data-exiting={!!inlineDialog || undefined} inert={!!inlineDialog} aria-hidden={!!inlineDialog || undefined}>
          <button className="model-picker" type="button" aria-label="Models & providers" aria-expanded={settings} disabled={!workspaceId} title={selectedModel ? `${selectedModel.provider} · ${selectedModel.name}` : "Models & providers"} onClick={() => setSettings((open) => !open)}>
            <Settings2 size={16} aria-hidden="true" /><span>{selectedModel ? selectedModel.name : "Models & providers"}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          <div className="send-actions">
            {workspaceId && browserControl && <button type="button" className="browser-control-action" disabled={browserControl.pending || (!browserControl.locked && !browserControl.ready)} aria-label={browserControl.locked ? "Take back control" : "Give agent control"} title={browserControl.locked ? "Take back control of both previews" : "Give agent control of both previews for checks; interactions need approval"} onClick={browserControl.locked ? browserControl.onRevoke : browserControl.onGrant}>
              {browserControl.locked ? <Hand size={16} aria-hidden="true" /> : <ScanEye size={16} aria-hidden="true" />}
            </button>}
            <ComposerAction action={action} instant={keyboardAction.current} type={stopAction ? "button" : "submit"}
              disabled={settings || !!inlineDialog || !workspaceId || busy || stopping || (!stopAction && (!draft.trim() || !agent.selectedModel))}
              title={stopAction ? "Stop agent work" : working ? "Send after the current response" : "Send message"}
              onClick={stopAction ? stop : undefined} />
          </div>
        </div>
      </form>
    </SelectionComposer>
    {dialog && workspaceId && dialog.kind === "approval" && <AgentPromptDialog key={dialog.id} workspaceId={workspaceId} dialog={dialog} onClose={() => dismissDialog(dialog.id)} />}
  </>;
}
