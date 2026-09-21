import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  THINKING_LEVELS,
  selectionContext,
  type AgentDialog,
  type AgentDialogResponse,
  type AgentEvent,
  type AgentLoginRequest,
  type AgentMessageView,
  type AgentModelRequest,
  type AgentModelView,
  type AgentProviderView,
  type AgentRenameRequest,
  type AgentRunState,
  type AgentSendRequest,
  type AgentSessionRequest,
  type AgentSessionView,
  type AgentSnapshot,
  type AgentThinkingLevel,
  type AgentThinkingRequest,
  type AgentToolActivityView,
} from "../../application/agent-contract";

type AgentDialogInput = AgentDialog extends infer Dialog ? Dialog extends AgentDialog ? Omit<Dialog, "id"> : never : never;

interface PendingDialog {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as { type?: string; text?: unknown; name?: unknown };
    if ((value.type === "text" || value.type === "thinking") && typeof value.text === "string") return [value.text];
    if (value.type === "toolCall" && typeof value.name === "string") return [`Used ${value.name}`];
    return [];
  }).join("\n");
}

function boundedJson(value: unknown, max = 12_000): string {
  try {
    const text = JSON.stringify(value, (key, item) => /(?:api.?key|password|secret|token|credential)/i.test(key) ? "[redacted]" : item, 2);
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  } catch {
    return "Output could not be displayed.";
  }
}

function classifyError(error: unknown): NonNullable<AgentSnapshot["error"]> {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/(?:sk-|key-|token-)[A-Za-z0-9_.-]{8,}/g, "[redacted]").slice(0, 1_000);
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return { kind: "rate-limit", message: "The provider rate limit was reached. Wait and try again." };
  if (/auth|credential|api.?key|login|oauth|unauthori[sz]ed|\b401\b|\b403\b/i.test(message)) return { kind: "auth", message: "Authentication is missing or expired. Open Models & providers to sign in again." };
  if (/image|vision|multimodal|capabilit/i.test(message)) return { kind: "capability", message };
  if (/catalog|models.*(?:load|refresh)|fetch.*models/i.test(message)) return { kind: "catalog", message: "The model catalog could not be refreshed. Cached models remain available." };
  return { kind: "runtime", message: message || "The agent runtime failed." };
}

function supportedThinking(model: { reasoning: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): AgentThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
    return true;
  });
}

/** Owns the single pi SDK writer for one open Mauxi workspace. */
export class PiAgentHost {
  private runtime?: AgentSessionRuntime;
  private modelRuntime?: ModelRuntime;
  private unsubscribe?: () => void;
  private listeners = new Set<(event: AgentEvent) => void>();
  private providers: AgentProviderView[] = [];
  private activities = new Map<string, AgentToolActivityView>();
  private pendingDialogs = new Map<string, PendingDialog>();
  private runState: AgentRunState = "idle";
  private status = "Choose a provider and model to begin.";
  private lastError?: AgentSnapshot["error"];
  private queued = { steering: 0, followUp: 0 };
  private initPromise?: Promise<void>;
  private publishQueued = false;
  private readonly sessionDir: string;
  private readonly captureRoot: string;

  constructor(
    readonly workspaceId: string,
    readonly cwd: string,
    private readonly profileDir: string,
    captureRoot: string,
  ) {
    this.sessionDir = path.join(profileDir, "sessions", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    this.captureRoot = path.resolve(captureRoot);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeOnce();
    return this.initPromise;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    this.modelRuntime = await ModelRuntime.create({
      authPath: path.join(this.profileDir, "auth.json"),
      modelsPath: path.join(this.profileDir, "models.json"),
      modelsStorePath: path.join(this.profileDir, "models-store.json"),
      allowModelNetwork: false,
    });

    const askQuestion = defineTool({
      name: "ask_question",
      label: "Ask a question",
      description: "Ask the user a structured question when their preference or missing input is required. Never infer approval from cancellation.",
      parameters: Type.Object({
        question: Type.String({ maxLength: 1_000 }),
        options: Type.Optional(Type.Array(Type.Object({
          id: Type.String({ maxLength: 100 }),
          label: Type.String({ maxLength: 200 }),
          description: Type.Optional(Type.String({ maxLength: 500 })),
        }), { maxItems: 12 })),
      }),
      execute: async (_id, input) => {
        try {
          const value = await this.requestDialog(input.options?.length ? {
            kind: "select", title: "Mauxi needs your input", message: input.question, options: input.options,
          } : {
            kind: "text", title: "Mauxi needs your input", message: input.question,
          });
          return { content: [{ type: "text", text: `User response: ${value}` }], details: { cancelled: false } };
        } catch {
          return { content: [{ type: "text", text: "The user cancelled the question. No choice or approval was provided." }], details: { cancelled: true } };
        }
      },
    });

    const resolveProjectPath = async (input: string): Promise<string> => {
      const root = await realpath(this.cwd);
      const candidate = await realpath(path.resolve(root, input));
      const relative = path.relative(root, candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path is outside the open project.");
      return candidate;
    };
    const workspaceRead = defineTool({
      name: "workspace_read",
      label: "Read project file",
      description: "Read a bounded text file inside the open project. Paths outside the project, including Mauxi credentials, are inaccessible.",
      parameters: Type.Object({ path: Type.String({ maxLength: 4_096 }), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })) }),
      execute: async (_id, input) => {
        const file = await resolveProjectPath(input.path);
        const info = await stat(file);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("File is not a bounded text file.");
        const lines = (await readFile(file, "utf8")).split("\n");
        const offset = input.offset ?? 1; const limit = input.limit ?? 400;
        return { content: [{ type: "text", text: lines.slice(offset - 1, offset - 1 + limit).join("\n") }], details: { path: path.relative(this.cwd, file), offset, totalLines: lines.length } };
      },
    });
    const workspaceList = defineTool({
      name: "workspace_list",
      label: "List project directory",
      description: "List files and directories inside the open project.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 4_096 })) }),
      execute: async (_id, input) => {
        const directory = await resolveProjectPath(input.path ?? ".");
        const entries = (await readdir(directory, { withFileTypes: true })).slice(0, 500).map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`);
        return { content: [{ type: "text", text: entries.join("\n") }], details: { path: path.relative(this.cwd, directory), count: entries.length } };
      },
    });
    const workspaceSearch = defineTool({
      name: "workspace_search",
      label: "Search project text",
      description: "Search for literal text in bounded text files inside the open project.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), path: Type.Optional(Type.String({ maxLength: 4_096 })) }),
      execute: async (_id, input) => {
        const root = await resolveProjectPath(input.path ?? ".");
        const results: string[] = []; let visited = 0;
        const walk = async (directory: string): Promise<void> => {
          if (results.length >= 200 || visited >= 2_000) return;
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (results.length >= 200 || visited++ >= 2_000) break;
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".mauxi-")) continue;
            const target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { await walk(target); continue; }
            const info = await stat(target); if (info.size > 1_000_000) continue;
            let text: string; try { text = await readFile(target, "utf8"); } catch { continue; }
            if (text.includes("\0")) continue;
            text.split("\n").forEach((line, index) => { if (results.length < 200 && line.includes(input.query)) results.push(`${path.relative(this.cwd, target)}:${index + 1}: ${line.slice(0, 500)}`); });
          }
        };
        await walk(root);
        return { content: [{ type: "text", text: results.join("\n") || "No matches." }], details: { matches: results.length, filesVisited: visited } };
      },
    });

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.profileDir,
        modelRuntime: this.modelRuntime!,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          appendSystemPrompt: [
            "You are embedded in Mauxi's read-only inspection phase. Inspect and explain the open project, but do not modify files, execute commands, install packages, or claim that changes were applied. Use ask_question when a user decision is required.",
          ],
        },
      });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          tools: ["workspace_read", "workspace_list", "workspace_search", "ask_question"],
          customTools: [workspaceRead, workspaceList, workspaceSearch, askQuestion],
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir: this.profileDir,
      sessionManager: SessionManager.create(this.cwd, this.sessionDir),
    });
    this.runtime.setRebindSession(async (session) => this.bindSession(session));
    await this.bindSession(this.runtime.session);
    await this.refreshProviderViews();
    this.status = this.runtime.session.model ? "Ready" : "Choose an authenticated model to begin.";
    await this.publish();
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    this.activities.clear();
    this.queued = { steering: 0, followUp: 0 };
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": this.runState = "working"; this.status = "Working…"; this.lastError = undefined; break;
      case "agent_end": if (event.willRetry) { this.runState = "retrying"; this.status = "Retrying…"; } break;
      case "agent_settled": this.runState = "idle"; this.status = "Ready"; break;
      case "compaction_start": this.runState = "compacting"; this.status = "Compacting conversation…"; break;
      case "compaction_end": if (!event.willRetry) this.runState = event.errorMessage ? "error" : "working"; break;
      case "auto_retry_start": this.runState = "retrying"; this.status = `Retrying (${event.attempt}/${event.maxAttempts})…`; break;
      case "auto_retry_end": if (!event.success && event.finalError) { this.runState = "error"; this.lastError = classifyError(event.finalError); } break;
      case "queue_update": this.queued = { steering: event.steering.length, followUp: event.followUp.length }; break;
      case "tool_execution_start":
        this.activities.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, status: "running", input: boundedJson(event.args) });
        break;
      case "tool_execution_update": {
        const current = this.activities.get(event.toolCallId);
        if (current) this.activities.set(event.toolCallId, { ...current, output: boundedJson(event.partialResult) });
        break;
      }
      case "tool_execution_end": {
        const current = this.activities.get(event.toolCallId);
        this.activities.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, input: current?.input, output: boundedJson(event.result), status: event.isError ? "error" : "done" });
        break;
      }
      case "message_end": {
        const value = event.message as unknown as { role?: string; stopReason?: string; errorMessage?: string };
        if (value.role === "assistant" && value.stopReason === "error") {
          this.runState = "error";
          const failure = classifyError(value.errorMessage ?? "Provider request failed");
          this.lastError = failure;
          this.status = failure.message;
        }
        break;
      }
    }
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => { this.publishQueued = false; void this.publish(); });
  }

  private async refreshProviderViews(): Promise<void> {
    if (!this.modelRuntime) return;
    this.providers = await Promise.all(this.modelRuntime.getProviders().map(async (provider) => {
      let auth: Awaited<ReturnType<ModelRuntime["checkAuth"]>>;
      try { auth = await this.modelRuntime!.checkAuth(provider.id, { signal: AbortSignal.timeout(8_000) }); }
      catch { auth = undefined; }
      const methods: AgentProviderView["authMethods"] = [];
      if (provider.auth.oauth) methods.push({ type: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
      if (provider.auth.apiKey?.login) methods.push({ type: "api_key", label: provider.auth.apiKey.name });
      return { id: provider.id, name: provider.name, authenticated: !!auth, authSource: auth?.source, authMethods: methods };
    }));
  }

  private modelViews(): AgentModelView[] {
    if (!this.modelRuntime) return [];
    const available = new Set(this.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
    return this.modelRuntime.getModels().map((model) => ({
      key: `${model.provider}/${model.id}`,
      provider: model.provider,
      id: model.id,
      name: model.name,
      available: available.has(`${model.provider}/${model.id}`),
      supportsImages: model.input.includes("image"),
      thinkingLevels: supportedThinking(model),
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }

  private messageViews(): AgentMessageView[] {
    if (!this.runtime) return [];
    const session = this.runtime.session;
    const messages: unknown[] = [...session.messages];
    const streaming = session.state.streamingMessage;
    if (streaming && !messages.includes(streaming)) messages.push(streaming);
    return messages.flatMap((message, index) => {
      const value = message as { role?: string; stopReason?: string; errorMessage?: string };
      if (value.role !== "user" && value.role !== "assistant") return [];
      const text = messageText(message);
      if (!text && !value.errorMessage && message !== streaming) return [];
      const contextIndex = value.role === "user" ? text.indexOf("\n\n<selected_context>") : -1;
      const visibleText = contextIndex >= 0
        ? `${text.slice(0, contextIndex)}\n\nSelected preview context attached to this request.`
        : text;
      return [{
        id: `${session.sessionId}:${message === streaming ? "streaming" : index}`,
        role: value.role,
        text: visibleText || value.errorMessage || (message === streaming ? "" : "No response text"),
        pending: message === streaming,
        error: value.stopReason === "error",
      } as AgentMessageView];
    });
  }

  private async sessionViews(): Promise<AgentSessionView[]> {
    if (!this.runtime) return [];
    const sessions = await SessionManager.list(this.cwd, this.sessionDir);
    return sessions.map((item) => ({
      id: item.id,
      name: item.name,
      createdAt: item.created.toISOString(),
      updatedAt: item.modified.toISOString(),
      firstMessage: item.firstMessage.slice(0, 160),
      active: item.id === this.runtime!.session.sessionId,
    }));
  }

  async snapshot(): Promise<AgentSnapshot> {
    if (!this.runtime) await this.initialize();
    const session = this.runtime!.session;
    const selectedKey = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
    const selectedAvailable = selectedKey ? this.modelRuntime!.getAvailableSnapshot().some((model) => `${model.provider}/${model.id}` === selectedKey) : false;
    return {
      ready: true,
      workspaceId: this.workspaceId,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      providers: this.providers,
      models: this.modelViews(),
      selectedModel: selectedAvailable ? selectedKey : undefined,
      thinkingLevel: session.thinkingLevel as AgentThinkingLevel,
      sessions: await this.sessionViews(),
      messages: this.messageViews(),
      tools: [...this.activities.values()],
      runState: this.runState,
      queued: this.queued,
      status: this.status,
      error: this.lastError,
    };
  }

  private async publish(): Promise<void> {
    if (!this.runtime) return;
    const snapshot = await this.snapshot();
    for (const listener of this.listeners) listener({ type: "snapshot", snapshot });
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) throw new Error("Stale agent workspace");
  }

  private requestDialog(dialog: AgentDialogInput, signal?: AbortSignal): Promise<string> {
    const id = randomUUID();
    const agentWasRunning = !!this.runtime?.session.isStreaming;
    if (agentWasRunning) { this.runState = "waiting"; this.status = "Waiting for your response…"; this.schedulePublish(); }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pendingDialogs.delete(id);
        if (agentWasRunning) { this.runState = "working"; this.status = "Working…"; this.schedulePublish(); }
        for (const listener of this.listeners) listener({ type: "dialog-dismissed", id });
      };
      this.pendingDialogs.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      if (signal) {
        if (signal.aborted) { this.pendingDialogs.get(id)?.reject(new Error("Dialog cancelled")); return; }
        signal.addEventListener("abort", () => this.pendingDialogs.get(id)?.reject(new Error("Dialog cancelled")), { once: true });
      }
      for (const listener of this.listeners) listener({ type: "dialog", dialog: { ...dialog, id } as AgentDialog });
    });
  }

  respondToDialog(response: AgentDialogResponse): void {
    this.assertWorkspace(response.workspaceId);
    const pending = this.pendingDialogs.get(response.dialogId);
    if (!pending) return;
    if (response.cancelled || typeof response.value !== "string") pending.reject(new Error("User cancelled"));
    else pending.resolve(response.value.slice(0, 8_000));
  }

  async login(request: AgentLoginRequest): Promise<void> {
    this.assertWorkspace(request.workspaceId);
    await this.initialize();
    const provider = this.modelRuntime!.getProvider(request.providerId);
    if (!provider) throw new Error("Unknown provider.");
    if (request.type === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login) throw new Error("This provider does not support that setup method.");
    this.status = `Setting up ${provider.name}…`; this.lastError = undefined; await this.publish();
    const controller = new AbortController();
    const notices = new Set<string>();
    const dismissNotice = (id: string) => {
      notices.delete(id); this.pendingDialogs.delete(id);
      for (const listener of this.listeners) listener({ type: "dialog-dismissed", id });
    };
    try {
      await this.modelRuntime!.login(request.providerId, request.type, {
        signal: controller.signal,
        prompt: (prompt) => this.requestDialog({
          kind: prompt.type,
          title: provider.name,
          message: prompt.message,
          ...(prompt.type === "select" ? { options: [...prompt.options] } : { placeholder: prompt.placeholder }),
        } as AgentDialogInput, prompt.signal),
        notify: (event) => {
          const dialog: AgentDialog = event.type === "auth_url"
            ? { id: randomUUID(), kind: "info", title: provider.name, message: event.instructions ?? "Continue authentication in your browser.", links: [{ url: event.url, label: "Open sign-in" }], cancellable: true }
            : event.type === "device_code"
              ? { id: randomUUID(), kind: "info", title: provider.name, message: `Enter code ${event.userCode} at ${event.verificationUri}`, links: [{ url: event.verificationUri, label: "Open verification page" }], cancellable: true }
              : { id: randomUUID(), kind: event.type === "progress" ? "progress" : "info", title: provider.name, message: event.message, links: event.type === "info" ? [...(event.links ?? [])] : undefined };
          if (dialog.cancellable) {
            notices.add(dialog.id);
            this.pendingDialogs.set(dialog.id, { resolve: () => dismissNotice(dialog.id), reject: () => { dismissNotice(dialog.id); controller.abort(); } });
          }
          for (const listener of this.listeners) listener({ type: "dialog", dialog });
        },
      });
      await this.refreshProviderViews();
      this.status = `${provider.name} is connected.`;
    } catch (error) {
      const cancelled = /cancel|abort/i.test(error instanceof Error ? error.message : String(error));
      const failure: NonNullable<AgentSnapshot["error"]> = { kind: "auth", message: cancelled ? "Provider setup cancelled." : "Provider setup failed. Check the credential and try again." };
      this.lastError = failure;
      this.status = failure.message;
      throw new Error(this.status);
    } finally {
      for (const id of [...notices]) dismissNotice(id);
      await this.publish();
    }
  }

  async logout(workspaceId: string, providerId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.initialize();
    if (!this.modelRuntime!.getProvider(providerId)) throw new Error("Unknown provider");
    await this.modelRuntime!.logout(providerId, { signal: AbortSignal.timeout(10_000) });
    await this.refreshProviderViews();
    if (this.runtime!.session.model?.provider === providerId) this.status = "Provider disconnected. Choose an authenticated model.";
    await this.publish();
  }

  async refreshCatalog(workspaceId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.initialize();
    const result = await this.modelRuntime!.refresh({ allowNetwork: true, force: true, signal: AbortSignal.timeout(15_000) });
    await this.refreshProviderViews();
    if (result.errors.size || result.aborted) {
      this.lastError = { kind: "catalog", message: result.aborted ? "Model catalog refresh timed out. Cached models remain available." : "Some model catalogs could not be refreshed. Cached models remain available." };
      this.status = this.lastError.message;
    } else { this.lastError = undefined; this.status = "Model catalog refreshed."; }
    await this.publish();
  }

  async selectModel(request: AgentModelRequest): Promise<void> {
    this.assertWorkspace(request.workspaceId);
    await this.initialize();
    const split = request.modelKey.indexOf("/");
    const model = split > 0 ? this.modelRuntime!.getModel(request.modelKey.slice(0, split), request.modelKey.slice(split + 1)) : undefined;
    const available = this.modelRuntime!.getAvailableSnapshot().some((item) => item.provider === model?.provider && item.id === model?.id);
    if (!model || !available) throw new Error("Authenticate this provider before selecting the model.");
    await this.runtime!.session.setModel(model);
    this.status = `Using ${model.name}`; this.lastError = undefined;
    await this.publish();
  }

  async setThinking(request: AgentThinkingRequest): Promise<void> {
    this.assertWorkspace(request.workspaceId);
    const model = this.runtime?.session.model;
    if (!model || !supportedThinking(model).includes(request.level)) throw new Error("This model does not support that thinking level.");
    this.runtime!.session.setThinkingLevel(request.level);
    await this.publish();
  }

  private async imageInputs(request: AgentSendRequest): Promise<Array<{ type: "image"; data: string; mimeType: "image/png" }>> {
    const paths = request.selections.flatMap((item) => item.capture.screenshot.status === "captured" && item.capture.screenshot.path ? [item.capture.screenshot.path] : []);
    if (!paths.length) return [];
    if (!this.runtime!.session.model?.input.includes("image")) throw new Error("The selected model cannot see image attachments. Choose an image-capable model or remove the visual selections.");
    return Promise.all(paths.map(async (file) => {
      const resolved = path.resolve(file);
      const relative = path.relative(this.captureRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("An attachment is outside Mauxi's capture directory.");
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error("An image attachment is invalid or too large.");
      return { type: "image" as const, data: (await readFile(resolved)).toString("base64"), mimeType: "image/png" as const };
    }));
  }

  async send(request: AgentSendRequest): Promise<{ accepted: boolean }> {
    this.assertWorkspace(request.workspaceId);
    await this.initialize();
    const text = request.text.trim();
    if (!text || text.length > 100_000) throw new Error("Invalid message");
    const selectedModel = this.runtime!.session.model;
    const selectedAvailable = selectedModel && this.modelRuntime!.getAvailableSnapshot().some((model) => model.provider === selectedModel.provider && model.id === selectedModel.id);
    if (!selectedModel || !selectedAvailable) throw new Error("Choose an authenticated model before sending.");
    if (request.selections.length > 8 || request.selections.some((item) => item.status !== "current" || item.capture.workspaceId !== this.workspaceId)) throw new Error("Attached context is stale or belongs to another workspace.");
    const images = await this.imageInputs(request);
    const prompt = `${text}${selectionContext(request.selections)}`;
    this.lastError = undefined;
    if (request.behavior === "steer") { await this.runtime!.session.steer(prompt, images); return { accepted: true }; }
    if (request.behavior === "followUp") { await this.runtime!.session.followUp(prompt, images); return { accepted: true }; }
    let settleAcceptance!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>((resolve) => { settleAcceptance = resolve; });
    void this.runtime!.session.prompt(prompt, { images, preflightResult: settleAcceptance }).catch((error) => {
      const failure = classifyError(error); this.lastError = failure; this.runState = "error"; this.status = failure.message; settleAcceptance(false); void this.publish();
    });
    const result = await accepted;
    return { accepted: result };
  }

  async stop(workspaceId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    if (!this.runtime) return;
    this.runState = "stopping"; this.status = "Stopping…"; await this.publish();
    await this.runtime.session.abort();
  }

  async newSession(workspaceId: string): Promise<void> {
    this.assertWorkspace(workspaceId);
    await this.initialize();
    await this.runtime!.session.waitForIdle();
    const result = await this.runtime!.newSession();
    if (!result.cancelled) { this.runState = "idle"; this.status = "New conversation"; this.lastError = undefined; await this.publish(); }
  }

  async resume(request: AgentSessionRequest): Promise<void> {
    this.assertWorkspace(request.workspaceId);
    await this.initialize();
    await this.runtime!.session.waitForIdle();
    const sessions = await SessionManager.list(this.cwd, this.sessionDir);
    const selected = sessions.find((item) => item.id === request.sessionId);
    if (!selected) throw new Error("Conversation not found");
    const result = await this.runtime!.switchSession(selected.path, { cwdOverride: this.cwd });
    if (!result.cancelled) { this.runState = "idle"; this.status = "Conversation resumed. Project files were not restored."; this.lastError = undefined; await this.publish(); }
  }

  async rename(request: AgentRenameRequest): Promise<void> {
    this.assertWorkspace(request.workspaceId);
    const name = request.name.trim();
    if (!name || name.length > 120) throw new Error("Conversation name must be 1–120 characters.");
    this.runtime!.session.setSessionName(name);
    await this.publish();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const pending of this.pendingDialogs.values()) pending.reject(new Error("Workspace closed"));
    this.pendingDialogs.clear();
    if (this.runtime?.session.isStreaming || this.runtime?.session.isCompacting) {
      try { await this.runtime.session.abort(); } catch { /* disposal still invalidates the runtime */ }
    }
    await this.runtime?.dispose();
    this.runtime = undefined;
    this.listeners.clear();
  }
}
