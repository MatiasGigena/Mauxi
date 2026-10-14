import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { BrowserActionTarget, BrowserRequest, BrowserResult, BrowserTarget } from "../../application/browser-contract";
import type { VisibleBrowserAdapter } from "../../application/browser-control";
import type { PreviewId } from "../../application/preview-contract";
import { BRIDGE_PARAMS, supportedRoute } from "../../application/route-link";
import { VISIBLE_BROWSER_SCRIPT } from "../preview/browser-script";
import { inspectDomSource } from "../project/dom-source";

type CdpParams = Record<string, string | number | boolean | string[] | undefined>;

const Frame = Type.Object({ id: Type.String(), url: Type.String(), loaderId: Type.String() });
const FrameTree = Type.Object({ frameTree: Type.Object({ frame: Frame, childFrames: Type.Optional(Type.Array(Type.Object({ frame: Frame }))) }) });
const TargetInfos = Type.Object({ targetInfos: Type.Array(Type.Object({ targetId: Type.String(), type: Type.String(), parentFrameId: Type.Optional(Type.String()) })) });
const FrameOwner = Type.Object({ backendNodeId: Type.Number() });
const DescribedNode = Type.Object({ node: Type.Object({ nodeName: Type.String(), attributes: Type.Optional(Type.Array(Type.String())) }) });
const IsolatedWorld = Type.Object({ executionContextId: Type.Number() });
const NavigateResult = Type.Object({ errorText: Type.Optional(Type.String()) });
const RequestedNode = Type.Object({ nodeId: Type.Number() });
const ExceptionDescription = Type.Optional(Type.Object({ description: Type.Optional(Type.String()) }));
const EvaluateResult = Type.Object({ result: Type.Object({ value: Type.Optional(Type.Unknown()), objectId: Type.Optional(Type.String()) }), exceptionDetails: Type.Optional(Type.Object({ exception: ExceptionDescription })) });
const Observation = Type.Object({ text: Type.Refine(Type.String(), text => text.length <= 100_000) });
const SourceLocator = Type.Object({ tag: Type.String(), testId: Type.String() });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const Bounds = Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() });
const ActionTarget = Type.Refine(Type.Object({ tag: Type.String(), text: Type.String(), label: Type.String(), role: nullableString, testId: nullableString, type: nullableString, bounds: Bounds }), target => JSON.stringify(target).length <= 4096);
const Geometry = Type.Union([Type.Null(), Bounds]);
const AttachedToTarget = Type.Object({ sessionId: Type.String(), targetInfo: Type.Object({ targetId: Type.String() }) });
const ContextCreated = Type.Object({ context: Type.Object({ id: Type.Number(), auxData: Type.Optional(Type.Object({ frameId: Type.Optional(Type.String()) })) }) });
const ContextDestroyed = Type.Object({ executionContextId: Type.Number() });
const FrameEvent = Type.Object({ frame: Type.Optional(Type.Object({ id: Type.String() })), frameId: Type.Optional(Type.String()), url: Type.Optional(Type.String()) });
const ConsoleCalled = Type.Object({ type: Type.String(), executionContextId: Type.Number(), args: Type.Optional(Type.Array(Type.Object({ type: Type.String(), value: Type.Optional(Type.Unknown()) }))) });
const ExceptionThrown = Type.Object({ exceptionDetails: Type.Object({ executionContextId: Type.Optional(Type.Number()), text: Type.Optional(Type.String()), exception: ExceptionDescription }) });
const ConsoleScalar = Type.Union([Type.String(), Type.Number()]);

type FrameTreeNode = Static<typeof FrameTree>["frameTree"];

interface BoundTarget extends BrowserTarget { frameId: string; loaderId: string; context?: number; backendNodeId: number; bootstrapUrl: string }

export class ElectronVisibleBrowser implements VisibleBrowserAdapter {
  private bound = new Map<PreviewId, BoundTarget>();
  private sessions = new Map<string, string>();
  private contexts = new Map<string, string>();
  private logs = new Map<string, string[]>();
  private initialized?: Promise<void>;
  private dead = false;
  private hovered: Array<{ nodeId: number; sessionId?: string }> = [];
  constructor(private window: BrowserWindow, readonly workspaceId: string, private origin: string, private root: string, private invalidate: (reason: string) => void) {}
  private async send(method: string, params: CdpParams = {}, sessionId?: string): Promise<void> {
    if (this.dead || this.window.isDestroyed()) throw new Error("Visible browser disconnected");
    await this.window.webContents.debugger.sendCommand(method, params, sessionId);
  }
  private async query<T extends TSchema>(schema: T, method: string, params: CdpParams = {}, sessionId?: string): Promise<Static<T>> {
    if (this.dead || this.window.isDestroyed()) throw new Error("Visible browser disconnected");
    const result = await this.window.webContents.debugger.sendCommand(method, params, sessionId);

    if (!Value.Check(schema, result)) throw new Error(`Unexpected ${method} response`);

    return result;
  }
  private initialize() {
    return this.initialized ??= (async () => {
      const debug = this.window.webContents.debugger;

      if (!debug.isAttached()) debug.attach("1.3");
      debug.on("detach", () => { this.dead = true; this.invalidate("Browser debugger disconnected"); });
      debug.on("message", (_event, method, params, sessionId) => {
        if (method === "Target.attachedToTarget" && Value.Check(AttachedToTarget, params)) {
          this.sessions.set(params.targetInfo.targetId, params.sessionId);
          void Promise.all([this.send("Runtime.enable", {}, params.sessionId), this.send("Page.enable", {}, params.sessionId)]).catch(() => this.invalidate("Preview disconnected"));
        }

        if (method === "Runtime.executionContextCreated" && Value.Check(ContextCreated, params)) this.contexts.set(`${sessionId ?? ""}:${params.context.id}`, params.context.auxData?.frameId ?? "");

        if (method === "Runtime.executionContextDestroyed" && Value.Check(ContextDestroyed, params)) this.contexts.delete(`${sessionId ?? ""}:${params.executionContextId}`);

        if ((method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Page.frameDetached" || method === "Page.frameStartedNavigating") && Value.Check(FrameEvent, params)) {
          const id = params.frame?.id ?? params.frameId;

          for (const [preview, target] of this.bound) if (target.frameId === id) {
            if (method === "Page.navigatedWithinDocument" && params.url === target.url) continue;
            this.bound.delete(preview); this.logs.delete(target.frameId); this.invalidate("Preview navigated or disconnected; hand off again after it is ready");
          }
        }

        if (method === "Runtime.consoleAPICalled" && Value.Check(ConsoleCalled, params)) {
          const values = (params.args ?? []).map(arg => Value.Check(ConsoleScalar, arg.value) ? String(arg.value) : `[${arg.type}]`);
          this.record(`${sessionId ?? ""}:${params.executionContextId}`, `${params.type}: ${values.join(" ")}`);
        }

        if (method === "Runtime.exceptionThrown" && Value.Check(ExceptionThrown, params)) {
          const data = params.exceptionDetails;
          this.record(`${sessionId ?? ""}:${data.executionContextId}`, `page-error: ${data.text ?? "Uncaught exception"} ${data.exception?.description ?? ""}`);
        }
      });
      await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await this.send("Page.enable"); await this.send("Runtime.enable");
    })();
  }
  private record(context: string, text: string): void {
    const frameId = this.contexts.get(context);

    if (!frameId || ![...this.bound.values()].some(t => t.frameId === frameId)) return;

    const buffer = this.logs.get(frameId) ?? [];
    buffer.push(text.replace(/(?:sk-|key-|token-)[A-Za-z0-9_.-]{8,}/g, "[redacted]").slice(0, 1200));
    this.logs.set(frameId, buffer.slice(-40));
  }
  async targets(): Promise<BrowserTarget[]> {
    if (this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized()) { this.invalidate("Visible window unavailable; browser control returned"); throw new Error("Visible window unavailable"); }

    await this.initialize();
    const { frameTree } = await this.query(FrameTree, "Page.getFrameTree");
    const children: FrameTreeNode[] = [...(frameTree.childFrames ?? [])];
    const { targetInfos } = await this.query(TargetInfos, "Target.getTargets");

    for (const info of targetInfos) {
      const sessionId = this.sessions.get(info.targetId);

      if (info.type !== "iframe" || info.parentFrameId !== frameTree.frame.id || !sessionId || children.some(child => child.frame.id === info.targetId)) continue;
      const remote = await this.query(FrameTree, "Page.getFrameTree", {}, sessionId);

      if (remote.frameTree.frame.id === info.targetId) children.push(remote.frameTree);
    }

    const found = new Set<PreviewId>();

    for (const child of children) {
      const frame = child.frame;
      let owner: { backendNodeId: number }; let attrs: string[];

      try {
        owner = await this.query(FrameOwner, "DOM.getFrameOwner", { frameId: frame.id });
        const { node } = await this.query(DescribedNode, "DOM.describeNode", { backendNodeId: owner.backendNodeId });

        if (node.nodeName !== "IFRAME") continue;
        attrs = node.attributes ?? [];
      } catch { continue; }

      const attributes = new Map<string, string>();

      for (let i = 0; i < attrs.length; i += 2) attributes.set(attrs[i], attrs[i+1]);
      const testId = attributes.get("data-testid");
      const previewId = testId === "desktop-preview" ? "desktop" : testId === "mobile-preview" ? "mobile" : undefined;

      if (!previewId || found.has(previewId)) continue;

      if (!supportedRoute(frame.url, this.origin)) { this.invalidate("Unsupported origin or callback route; browser control suspended"); continue; }

      found.add(previewId);
      const old = this.bound.get(previewId);

      if (!old || old.frameId !== frame.id || old.loaderId !== frame.loaderId || old.url !== frame.url) {
        if (old) this.invalidate("Current preview document changed");
        this.bound.set(previewId, { workspaceId: this.workspaceId, previewId, documentId: randomUUID(), url: frame.url, frameId: frame.id, loaderId: frame.loaderId, backendNodeId: owner.backendNodeId, bootstrapUrl: attributes.get("src") ?? frame.url });
      }
    }

    for (const id of this.bound.keys()) if (!found.has(id)) { this.bound.delete(id); this.invalidate("Visible preview unavailable"); }

    return [...this.bound.values()].map(({ workspaceId, previewId, documentId, url }) => ({ workspaceId, previewId, documentId, url }));
  }
  private async context(target: BoundTarget) {
    if (!target.context) {
      const result = await this.query(IsolatedWorld, "Page.createIsolatedWorld", { frameId: target.frameId, worldName: "mauxi-visible-tools" }, this.sessions.get(target.frameId));
      target.context = result.executionContextId;
    }

    return target.context;
  }
  async describeTarget(request: BrowserRequest, signal: AbortSignal): Promise<BrowserActionTarget> {
    const target = this.bound.get(request.previewId);

    if (!target || target.documentId !== request.documentId || target.url !== request.url) throw new Error("Stale visible target");
    signal.throwIfAborted();
    const contextId = await this.context(target); signal.throwIfAborted();

    const result = await this.query(EvaluateResult, "Runtime.evaluate", {
      contextId, expression: `(${VISIBLE_BROWSER_SCRIPT})(${JSON.stringify({ ...request, operation: "describe-target" })})`,
      returnByValue: true, awaitPromise: false, userGesture: false, timeout: 2000,
    }, this.sessions.get(target.frameId));

    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 800) ?? "Browser target could not be resolved");
    signal.throwIfAborted();

    if (this.bound.get(request.previewId) !== target) throw new Error("Document changed while resolving the browser target");
    const description = result.result.value;

    if (!Value.Check(ActionTarget, description)) throw new Error("Invalid browser target description");

    return description;
  }
  async execute(request: BrowserRequest, signal: AbortSignal, approvedTarget?: BrowserActionTarget): Promise<BrowserResult> {
    const target = this.bound.get(request.previewId);

    if (!target || target.documentId !== request.documentId || target.url !== request.url) throw new Error("Stale visible target");
    signal.throwIfAborted();

    if (request.operation === "console") return { text: JSON.stringify({ entries: this.logs.get(target.frameId) ?? [], scope: "Up to 40 console/page errors observed since connection in this document; absence is not proof of no errors." }) };

    if (request.operation === "screenshot") {
      const geometryScript = `(() => { if (document.querySelector('.agent-dialog, .chat-settings, .preview-tools, .repository-popover')) return null; const f = document.querySelector('[data-testid="${request.previewId}-preview"]'); const c = document.querySelector('[data-testid="canvas"]'); if (!f || !c || f.getClientRects().length === 0 || getComputedStyle(f).visibility !== 'visible') return null; const r=f.getBoundingClientRect(), a=c.getBoundingClientRect(); if(r.left<a.left || r.top<a.top || r.right>a.right+1 || r.bottom>a.bottom+1 || r.right>innerWidth || r.bottom>innerHeight) return null; return {x:Math.ceil(r.x), y:Math.ceil(r.y), width:Math.floor(r.width), height:Math.floor(r.height)}; })()`;
      const geometry = await this.window.webContents.executeJavaScript(geometryScript);

      if (!Value.Check(Geometry, geometry) || !geometry || geometry.width < 1 || geometry.height < 1) throw new Error("Close open panels and keep both previews fully visible before capturing; no hidden/offscreen capture was substituted");
      signal.throwIfAborted();
      const image = await this.window.webContents.capturePage(geometry);
      signal.throwIfAborted();

      if (JSON.stringify(await this.window.webContents.executeJavaScript(geometryScript)) !== JSON.stringify(geometry)) throw new Error("Visible preview geometry changed during capture; no verification recorded");

      if (this.bound.get(request.previewId) !== target) throw new Error("Document changed during capture");
      const bounded = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image;
      const data = bounded.toPNG();

      if (data.length > 5 * 1024 * 1024) throw new Error("Screenshot exceeds the bounded image budget");

      return { text: `Actual visible ${request.previewId} capture · ${bounded.getSize().width}×${bounded.getSize().height}. Only the displayed viewport was checked, not offscreen content.`, image: data.toString("base64") };
    }

    if (request.operation === "navigate") {
      const route = supportedRoute(request.route!, this.origin);

      if (!route) throw new Error("Unsupported origin, action or callback route");
      signal.throwIfAborted();
      const destination = new URL(route, this.origin), bootstrap = new URL(target.bootstrapUrl, this.origin);

      for (const key of BRIDGE_PARAMS) { const value = bootstrap.searchParams.get(key);

      if (value) destination.searchParams.set(key, value); }

      const result = await this.query(NavigateResult, "Page.navigate", { frameId: target.frameId, url: destination.href }, this.sessions.get(target.frameId));

      if (result.errorText) throw new Error(result.errorText);
      this.invalidate("Navigation sent; old browser control invalidated");

      return { text: "Navigation sent to the visible preview only. Peer navigation was not replayed. Wait for readiness, hand off again and inspect the new document." };
    }

    const context = await this.context(target); signal.throwIfAborted();
    const sessionId = this.sessions.get(target.frameId);

    if (request.operation === "hover") { await this.release(); signal.throwIfAborted(); }

    const result = await this.query(EvaluateResult, "Runtime.evaluate", { contextId: context, expression: `(${VISIBLE_BROWSER_SCRIPT})(${JSON.stringify(request)}, ${JSON.stringify(approvedTarget) ?? "null"})`, returnByValue: request.operation !== "hover", awaitPromise: false, userGesture: false, timeout: 2000 }, sessionId);

    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 800) ?? "Visible browser operation failed");

    if (request.operation === "hover") {
      const objectId = result.result.objectId;

      try {
        await this.send("DOM.enable", {}, sessionId); await this.send("CSS.enable", {}, sessionId);
        await this.send("DOM.getDocument", {}, sessionId);
        const { nodeId } = await this.query(RequestedNode, "DOM.requestNode", { objectId }, sessionId);
        signal.throwIfAborted();
        await this.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
        this.hovered.push({ nodeId, sessionId });

        return { text: "Hover events dispatched and CSS :hover applied to the original visible target. Synthetic events are untrusted; native OS pointer behavior remains unverified. Hover styling clears on take-back." };
      } finally { if (objectId) await this.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined); }
    }

    const value = result.result.value;

    if (!Value.Check(Observation, value)) throw new Error("Invalid bounded browser observation");

    if (request.operation === "source") {
      const locator = JSON.parse(value.text);

      if (!Value.Check(SourceLocator, locator)) throw new Error("Invalid bounded browser observation");
      const source = await inspectDomSource(this.root, locator.tag, locator.testId, signal);
      signal.throwIfAborted();

      if (this.bound.get(request.previewId) !== target) throw new Error("Document changed during source inspection");

      return { text: JSON.stringify(source) };
    }

    return { text: value.text };
  }
  async release() {
    const hovered = this.hovered.splice(0);
    await Promise.all(hovered.map(({ nodeId, sessionId }) => this.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }, sessionId).catch(() => undefined)));
  }
  dispose() { this.dead = true; this.bound.clear(); this.invalidate("Visible browser disconnected"); }
}
