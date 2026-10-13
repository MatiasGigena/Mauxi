import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserActionTarget, BrowserRequest, BrowserResult, BrowserTarget } from "../../application/browser-contract";
import type { VisibleBrowserAdapter } from "../../application/browser-control";
import type { PreviewId } from "../../application/preview-contract";
import { BRIDGE_PARAMS, supportedRoute } from "../../application/route-link";
import { VISIBLE_BROWSER_SCRIPT } from "../preview/browser-script";
import { inspectDomSource } from "../project/dom-source";

interface Frame { id: string; url: string; loaderId: string }
interface FrameTree { frame: Frame; childFrames?: FrameTree[] }
interface BoundTarget extends BrowserTarget { frameId: string; loaderId: string; context?: number; backendNodeId: number; bootstrapUrl: string }

/** Uses ONLY direct child frames owned by the visible shell's actual iframe elements. */
export class ElectronVisibleBrowser implements VisibleBrowserAdapter {
  private bound = new Map<PreviewId, BoundTarget>();
  private sessions = new Map<string, string>();
  private contexts = new Map<string, string>();
  private logs = new Map<string, string[]>();
  private initialized?: Promise<void>;
  private dead = false;
  private hovered: Array<{ nodeId: number; sessionId?: string }> = [];
  constructor(private window: BrowserWindow, readonly workspaceId: string, private origin: string, private root: string, private invalidate: (reason: string) => void) {}
  private command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.dead || this.window.isDestroyed()) return Promise.reject(new Error("Visible browser disconnected"));
    return this.window.webContents.debugger.sendCommand(method, params, sessionId);
  }
  private initialize() {
    return this.initialized ??= (async () => {
      const debug = this.window.webContents.debugger;
      if (!debug.isAttached()) debug.attach("1.3");
      debug.on("detach", () => { this.dead = true; this.invalidate("Browser debugger disconnected"); });
      debug.on("message", (_event, method, params, sessionId) => {
        if (method === "Target.attachedToTarget") {
          this.sessions.set(params.targetInfo.targetId, params.sessionId);
          void Promise.all([this.command("Runtime.enable", {}, params.sessionId), this.command("Page.enable", {}, params.sessionId)]).catch(() => this.invalidate("Preview disconnected"));
        }
        if (method === "Runtime.executionContextCreated") this.contexts.set(`${sessionId ?? ""}:${params.context.id}`, params.context.auxData?.frameId ?? "");
        if (method === "Runtime.executionContextDestroyed") this.contexts.delete(`${sessionId ?? ""}:${params.executionContextId}`);
        if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Page.frameDetached" || method === "Page.frameStartedNavigating") {
          const id = params.frame?.id ?? params.frameId;
          for (const [preview, target] of this.bound) if (target.frameId === id) {
            // Next hydration replaces history at the current URL. Chromium also
            // emits frameStartedLoading for that operation, without replacing
            // the document. Actual navigation starts still revoke immediately.
            if (method === "Page.navigatedWithinDocument" && params.url === target.url) continue;
            this.bound.delete(preview); this.logs.delete(id); this.invalidate("Preview navigated or disconnected; hand off again after it is ready");
          }
        }
        if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
          const data = params.exceptionDetails ?? params;
          const frameId = this.contexts.get(`${sessionId ?? ""}:${data.executionContextId}`);
          if (!frameId || ![...this.bound.values()].some(t => t.frameId === frameId)) return;
          // Never evaluate console objects/getters or retrieve remote object properties.
          const text = method === "Runtime.consoleAPICalled"
            ? `${params.type}: ${(params.args ?? []).map((arg: { value?: unknown; type: string }) => typeof arg.value === "string" || typeof arg.value === "number" ? String(arg.value) : `[${arg.type}]`).join(" ")}`
            : `page-error: ${data.text ?? "Uncaught exception"} ${data.exception?.description ?? ""}`;
          const buffer = this.logs.get(frameId) ?? [];
          buffer.push(text.replace(/(?:sk-|key-|token-)[A-Za-z0-9_.-]{8,}/g, "[redacted]").slice(0, 1200));
          this.logs.set(frameId, buffer.slice(-40));
        }
      });
      await this.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await this.command("Page.enable"); await this.command("Runtime.enable");
    })();
  }
  async targets(): Promise<BrowserTarget[]> {
    if (this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized()) { this.invalidate("Visible window unavailable; browser control returned"); throw new Error("Visible window unavailable"); }
    await this.initialize();
    const { frameTree } = await this.command("Page.getFrameTree") as { frameTree: FrameTree };
    const children = [...(frameTree.childFrames ?? [])];
    // file:// production shells place http previews in OOPIF targets. The root
    // Page tree omits those; join ONLY direct children of this exact shell and
    // still authenticate their owner iframe through the shell DOM below.
    const { targetInfos } = await this.command("Target.getTargets");
    for (const info of targetInfos) {
      const sessionId = this.sessions.get(info.targetId);
      if (info.type !== "iframe" || info.parentFrameId !== frameTree.frame.id || !sessionId || children.some(child => child.frame.id === info.targetId)) continue;
      const remote = await this.command("Page.getFrameTree", {}, sessionId) as { frameTree: FrameTree };
      if (remote.frameTree.frame.id === info.targetId) children.push(remote.frameTree);
    }
    const found = new Set<PreviewId>();
    for (const child of children) {
      const frame = child.frame;
      let owner: { backendNodeId: number }; let attrs: string[];
      try {
        owner = await this.command("DOM.getFrameOwner", { frameId: frame.id });
        const { node } = await this.command("DOM.describeNode", { backendNodeId: owner.backendNodeId });
        if (node.nodeName !== "IFRAME") continue;
        attrs = node.attributes ?? [];
      } catch { continue; }
      const attributes = new Map<string, string>(); for (let i = 0; i < attrs.length; i += 2) attributes.set(attrs[i], attrs[i+1]);
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
      const result = await this.command("Page.createIsolatedWorld", { frameId: target.frameId, worldName: "mauxi-visible-tools" }, this.sessions.get(target.frameId));
      target.context = result.executionContextId;
    }
    return target.context;
  }
  async describeTarget(request: BrowserRequest, signal: AbortSignal): Promise<BrowserActionTarget> {
    const target = this.bound.get(request.previewId);
    if (!target || target.documentId !== request.documentId || target.url !== request.url) throw new Error("Stale visible target");
    signal.throwIfAborted();
    const contextId = await this.context(target); signal.throwIfAborted();
    const result = await this.command("Runtime.evaluate", {
      contextId, expression: `(${VISIBLE_BROWSER_SCRIPT})(${JSON.stringify({ ...request, operation: "describe-target" })})`,
      returnByValue: true, awaitPromise: false, userGesture: false, timeout: 2000,
    }, this.sessions.get(target.frameId));
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 800) ?? "Browser target could not be resolved");
    signal.throwIfAborted();
    if (this.bound.get(request.previewId) !== target) throw new Error("Document changed while resolving the browser target");
    const description = result.result.value as BrowserActionTarget;
    if (!description || typeof description.tag !== "string" || !description.bounds || JSON.stringify(description).length > 4096) throw new Error("Invalid browser target description");
    return description;
  }
  async execute(request: BrowserRequest, signal: AbortSignal, approvedTarget?: BrowserActionTarget): Promise<BrowserResult> {
    const target = this.bound.get(request.previewId);
    if (!target || target.documentId !== request.documentId || target.url !== request.url) throw new Error("Stale visible target");
    signal.throwIfAborted();
    if (request.operation === "console") return { text: JSON.stringify({ entries: this.logs.get(target.frameId) ?? [], scope: "Up to 40 console/page errors observed since connection in this document; absence is not proof of no errors." }) };
    if (request.operation === "screenshot") {
      // Geometry comes from the trusted shell, never from the project page.
      const geometryScript = `(() => { if (document.querySelector('.agent-dialog, .chat-settings, .preview-tools, .repository-popover')) return null; const f = document.querySelector('[data-testid="${request.previewId}-preview"]'); const c = document.querySelector('[data-testid="canvas"]'); if (!f || !c || f.getClientRects().length === 0 || getComputedStyle(f).visibility !== 'visible') return null; const r=f.getBoundingClientRect(), a=c.getBoundingClientRect(); if(r.left<a.left || r.top<a.top || r.right>a.right+1 || r.bottom>a.bottom+1 || r.right>innerWidth || r.bottom>innerHeight) return null; return {x:Math.ceil(r.x), y:Math.ceil(r.y), width:Math.floor(r.width), height:Math.floor(r.height)}; })()`;
      const geometry = await this.window.webContents.executeJavaScript(geometryScript);
      if (!geometry || geometry.width < 1 || geometry.height < 1) throw new Error("Close open panels and keep both previews fully visible before capturing; no hidden/offscreen capture was substituted");
      signal.throwIfAborted();
      const image = await this.window.webContents.capturePage(geometry);
      signal.throwIfAborted();
      if (JSON.stringify(await this.window.webContents.executeJavaScript(geometryScript)) !== JSON.stringify(geometry)) throw new Error("Visible preview geometry changed during capture; no verification recorded");
      if (this.bound.get(request.previewId) !== target) throw new Error("Document changed during capture");
      const bounded = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image;
      const data = bounded.toPNG(); if (data.length > 5 * 1024 * 1024) throw new Error("Screenshot exceeds the bounded image budget");
      return { text: `Actual visible ${request.previewId} capture · ${bounded.getSize().width}×${bounded.getSize().height}. Only the displayed viewport was checked, not offscreen content.`, image: data.toString("base64") };
    }
    if (request.operation === "navigate") {
      const route = supportedRoute(request.route!, this.origin);
      if (!route) throw new Error("Unsupported origin, action or callback route");
      signal.throwIfAborted();
      const destination = new URL(route, this.origin), bootstrap = new URL(target.bootstrapUrl, this.origin);
      for (const key of BRIDGE_PARAMS) { const value = bootstrap.searchParams.get(key); if (value) destination.searchParams.set(key, value); }
      const result = await this.command("Page.navigate", { frameId: target.frameId, url: destination.href }, this.sessions.get(target.frameId));
      if (result.errorText) throw new Error(result.errorText);
      this.invalidate("Navigation sent; old browser control invalidated");
      return { text: "Navigation sent to the visible preview only. Peer navigation was not replayed. Wait for readiness, hand off again and inspect the new document." };
    }
    const context = await this.context(target); signal.throwIfAborted();
    const sessionId = this.sessions.get(target.frameId);
    if (request.operation === "hover") { await this.release(); signal.throwIfAborted(); }
    const result = await this.command("Runtime.evaluate", { contextId: context, expression: `(${VISIBLE_BROWSER_SCRIPT})(${JSON.stringify(request)}, ${JSON.stringify(approvedTarget) ?? "null"})`, returnByValue: request.operation !== "hover", awaitPromise: false, userGesture: false, timeout: 2000 }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 800) ?? "Visible browser operation failed");
    if (request.operation === "hover") {
      const objectId = result.result.objectId;
      try {
        await this.command("DOM.enable", {}, sessionId); await this.command("CSS.enable", {}, sessionId);
        await this.command("DOM.getDocument", {}, sessionId);
        const { nodeId } = await this.command("DOM.requestNode", { objectId }, sessionId);
        signal.throwIfAborted();
        await this.command("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
        this.hovered.push({ nodeId, sessionId });
        return { text: "Hover events dispatched and CSS :hover applied to the original visible target. Synthetic events are untrusted; native OS pointer behavior remains unverified. Hover styling clears on take-back." };
      } finally { if (objectId) await this.command("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined); }
    }
    const value = result.result.value;
    if (!value || typeof value.text !== "string" || value.text.length > 100_000) throw new Error("Invalid bounded browser observation");
    if (request.operation === "source") {
      const locator = JSON.parse(value.text);
      const source = await inspectDomSource(this.root, locator.tag, locator.testId, signal);
      signal.throwIfAborted();
      if (this.bound.get(request.previewId) !== target) throw new Error("Document changed during source inspection");
      return { text: JSON.stringify(source) };
    }
    return { text: value.text };
  }
  async release() {
    const hovered = this.hovered.splice(0);
    await Promise.all(hovered.map(({ nodeId, sessionId }) => this.command("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }, sessionId).catch(() => undefined)));
  }
  dispose() { this.dead = true; this.bound.clear(); this.invalidate("Visible browser disconnected"); }
}
