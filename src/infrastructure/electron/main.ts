import { startRendererServer } from "./renderer-server";
import { installPreviewHeaders } from "./preview-headers";
import { CaptureCache, CAPTURE_RETENTION } from "../storage/capture-cache";
import { selectionCapturePaths } from "../../application/selection-state";
import { app, BrowserWindow, dialog, ipcMain, shell, type Rectangle } from "electron";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceManager } from "../../application/workspace-manager";
import { isCanvasState } from "../../application/canvas-state";
import { THINKING_LEVELS } from "../../application/agent-contract";
import { PiAgentHost } from "../agent/pi-agent-host";
import { BrowserControl } from "../../application/browser-control";
import { ElectronVisibleBrowser } from "./visible-browser";
import { assertBrowserRequest } from "../../application/browser-contract";
import { JournalStore } from "../instrumentation/journal";
import { WorkspaceStore } from "../project/workspace-store";
import { ProjectPickerLocation } from "../project/project-picker-location";
import { resolveWorkspaceSource } from "../project/source-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const boundedString = (max: number) => Type.Refine(Type.String(), value => value.length <= max);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableInteger = Type.Union([Type.Integer(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const PreviewIdInput = Type.Union([Type.Literal("desktop"), Type.Literal("mobile")]);
const WorkspaceIdInput = boundedString(128);
const SourceLineInput = Type.Optional(nullableInteger);
const ownershipInput = Type.Union([Type.Literal("application"), Type.Literal("library"), Type.Literal("unknown")]);
const cssPixels = Type.Literal("preview-css-pixels");

const SourceLocatorInput = Type.Object({
  tag: Type.Refine(Type.String(), tag => /^[a-z][\w:-]{0,63}$/i.test(tag)),
  testIds: Type.Array(Type.Refine(Type.String(), item => item.length > 0 && item.length <= 512), { maxItems: 12 }),
});

const SourceRequestInput = Type.Object({ workspaceId: Type.String(), hint: boundedString(1_024), lineNumber: SourceLineInput, columnNumber: SourceLineInput, locator: Type.Optional(SourceLocatorInput) });
const FixtureSourceRequestInput = Type.Object({ fixture: Type.Union([Type.Literal("vite"), Type.Literal("next")]), hint: boundedString(1_024), lineNumber: SourceLineInput, columnNumber: SourceLineInput, locator: Type.Optional(SourceLocatorInput) });

const CaptureRequestInput = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  previewId: PreviewIdInput,
  selectionId: Type.Optional(Type.Refine(Type.String(), id => /^[\w-]{1,128}$/.test(id))),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
});

const BrowserOwnerInput = Type.Object({ workspaceId: Type.String(), owner: Type.Union([Type.Literal("agent"), Type.Literal("human"), Type.Literal("picker")]) });
const ProjectPathInput = boundedString(4_096);
const ConfirmProjectInput = Type.Object({ discoveryId: boundedString(128), planId: boundedString(128), mode: Type.Union([Type.Literal("start"), Type.Literal("attach")]), startPath: Type.Optional(Type.String()) });
const SaveCanvasInput = Type.Object({ workspaceId: WorkspaceIdInput, canvas: Type.Unknown() });
const BridgeReadyInput = Type.Object({ workspaceId: WorkspaceIdInput, previewId: PreviewIdInput, generation: boundedString(128), url: boundedString(4_096) });
const AgentLoginInput = Type.Object({ workspaceId: WorkspaceIdInput, providerId: boundedString(200), type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]) });
const AgentLogoutInput = Type.Object({ workspaceId: WorkspaceIdInput, providerId: boundedString(200) });
const AgentModelInput = Type.Object({ workspaceId: WorkspaceIdInput, modelKey: boundedString(500) });
const AgentThinkingInput = Type.Object({ workspaceId: WorkspaceIdInput, level: Type.Union(THINKING_LEVELS.map(level => Type.Literal(level))) });
const AgentDialogInput = Type.Object({ workspaceId: WorkspaceIdInput, dialogId: boundedString(128), value: Type.Optional(boundedString(8_000)), cancelled: Type.Optional(Type.Boolean()) });
const AuthUrlInput = boundedString(4_096);
const CaptureReleaseInput = Type.Array(Type.Refine(Type.String(), file => file.length > 0 && file.length <= 4_096), { maxItems: 8 });

const SelectionInput = Type.Object({
  capture: Type.Object({
    selectionId: Type.String(),
    workspaceId: Type.String(),
    previewId: PreviewIdInput,
    documentGeneration: Type.String(),
    capturedAt: Type.String(),
    url: Type.String(),
    viewport: Type.Object({ width: Type.Number(), height: Type.Number(), deviceScaleFactor: Type.Number() }),
    coordinates: Type.Object({ clientX: Type.Number(), clientY: Type.Number(), space: cssPixels }),
    element: Type.Object({ tag: Type.String(), label: Type.String(), role: nullableString, text: Type.String(), html: Type.String() }),
    bounds: Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() }),
    source: Type.Object({
      filePath: Type.String(),
      lineNumber: nullableNumber,
      columnNumber: nullableNumber,
      componentName: nullableString,
      method: Type.Union([Type.Literal("react-grab"), Type.Literal("jsx-attribute"), Type.Literal("unresolved")]),
      fileFingerprint: nullableString,
      role: Type.Union([Type.Literal("jsx-element"), Type.Literal("component-owner"), Type.Literal("caller"), Type.Literal("unknown")]),
      ownership: ownershipInput,
      verification: Type.Union([Type.Literal("unverified"), Type.Literal("verified"), Type.Literal("missing-or-ambiguous"), Type.Literal("library")]),
    }),
    componentOwners: Type.Array(Type.Object({
      componentName: Type.String(),
      filePath: nullableString,
      lineNumber: nullableNumber,
      columnNumber: nullableNumber,
      role: Type.Union([Type.Literal("component-owner"), Type.Literal("caller")]),
      ownership: ownershipInput,
    })),
    domAncestry: Type.Array(Type.Object({ tag: Type.String(), label: Type.String(), selector: nullableString, testId: nullableString, selected: Type.Boolean() })),
    support: Type.Object({ status: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]), reason: nullableString }),
    fingerprint: Type.Object({ selector: nullableString, tag: Type.String(), testId: nullableString, text: Type.String(), sourceKey: nullableString, instanceKey: Type.String() }),
    computedStyles: Type.Record(Type.String(), Type.String()),
    screenshot: Type.Object({
      status: Type.Union([Type.Literal("pending"), Type.Literal("captured"), Type.Literal("unavailable")]),
      crop: Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number(), space: cssPixels }),
      path: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
      capturedAt: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
  }),
  status: Type.Union([Type.Literal("current"), Type.Literal("stale")]),
  interaction: Type.Optional(Type.Union([Type.Literal("pointer"), Type.Literal("keyboard")])),
  staleReason: Type.Optional(Type.String()),
  requiresRepick: Type.Optional(Type.Boolean()),
});

const AgentSendInput = Type.Object({
  workspaceId: WorkspaceIdInput,
  text: boundedString(100_000),
  behavior: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
  selections: Type.Array(SelectionInput, { maxItems: 8 }),
});

let mainWindow: BrowserWindow | null = null;
const retiredCanvasSenders = new WeakMap<Electron.WebContents, Electron.WebFrameMain>();
let packagedRenderer: Awaited<ReturnType<typeof startRendererServer>> | undefined;
let currentWorkspaceRoot: string | null = null;
let manager: WorkspaceManager;
let projectPickerLocation: ProjectPickerLocation;
let quittingAfterCleanup = false;
let cleanupInProgress = false;
let agentHost: PiAgentHost | null = null;
let agentCreation: Promise<PiAgentHost> | null = null;
let unsubscribeAgent: (() => void) | null = null;
const approvedAuthUrls = new Set<string>();
let browserControl: BrowserControl | undefined;
let visibleBrowser: ElectronVisibleBrowser | undefined;
let browserHeartbeat = 0;
let captures: CaptureCache;
let captureCleanupTimer: ReturnType<typeof setInterval> | undefined;

function cleanupCaptureCache(): void {
  try { captures.cleanup(); }
  catch (error) { console.warn("Screenshot cache cleanup needs attention", error); }
}

const heartbeatTimer = setInterval(() => {
  if (browserControl?.state().owner === "agent" && Date.now() - browserHeartbeat > 4000) {
    browserControl.revoke("Preview UI disconnected");
    void agentHost?.stop(browserControl.workspaceId);
  }
}, 1000);

heartbeatTimer.unref();

function activeBrowser(): BrowserControl {
  const active = manager.snapshot().active;

  if (!active || !mainWindow) throw new Error("No active visible workspace");

  if (browserControl?.workspaceId === active.workspaceId) return browserControl;
  visibleBrowser?.dispose();
  let control: BrowserControl | undefined;
  visibleBrowser = new ElectronVisibleBrowser(mainWindow, active.workspaceId, active.origin, active.appRoot, reason => control?.revoke(reason));
  control = new BrowserControl(active.workspaceId, visibleBrowser, async (request, signal, target) => (await activeAgent()).approveBrowserAction(request, signal, target));
  browserControl = control;
  browserControl.subscribe(state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mauxi:browser-state", state); });

  return browserControl;
}

app.setName("Mauxi");

if (!app.requestSingleInstanceLock()) app.exit(0);

app.on("second-instance", () => {
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function sourceLocator(locator: Static<typeof SourceLocatorInput> | undefined): { tag: string; testIds: string[] } | undefined {
  return locator && { tag: locator.tag, testIds: locator.testIds };
}

function assertCaptureBounds(input: Static<typeof CaptureRequestInput>, bounds: Rectangle): void {
  const { x, y, width, height } = input;

  if (width < 1 || height < 1 || width > bounds.width || height > bounds.height) throw new Error("Capture dimensions exceed the shell");

  if (x < 0 || y < 0 || x + width > bounds.width + 1 || y + height > bounds.height + 1) throw new Error("Capture rectangle is outside the shell");
}

async function activeAgent(): Promise<PiAgentHost> {
  const active = manager.snapshot().active;

  if (!active) throw new Error("No active workspace");

  if (agentHost?.workspaceId === active.workspaceId) return agentHost;

  if (agentCreation) {
    const pending = await agentCreation;

    if (pending.workspaceId !== active.workspaceId) throw new Error("Agent workspace changed during startup");

    return pending;
  }

  agentCreation = (async () => {
    unsubscribeAgent?.(); unsubscribeAgent = null;
    const previous = agentHost; agentHost = null;
    await previous?.dispose();
    const userData = app.getPath("userData");
    const captureRoot = captures.root;

    const created = new PiAgentHost(active.workspaceId, active.appRoot, path.join(userData, "pi-profile"), captureRoot, undefined, activeBrowser(), async (target) => {
      const url = new URL(target);

      if (url.protocol !== "https:") throw new Error("Invalid authentication URL");
      await shell.openExternal(url.toString());
    }, path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."), "design-references", "library", "catalog.json"),
    path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."), "design-skills"));

    agentHost = created;
    unsubscribeAgent = created.subscribe((agentEvent) => {
      if (agentEvent.type === "dialog" && "links" in agentEvent.dialog) for (const link of agentEvent.dialog.links ?? []) {
        try { approvedAuthUrls.add(new URL(link.url).toString()); } catch {}
      }

      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mauxi:agent-event", agentEvent);
    });

    try { await created.initialize(); }
    catch (error) {
      if (agentHost === created) { unsubscribeAgent?.(); unsubscribeAgent = null; agentHost = null; }

      await created.dispose().catch(() => undefined);
      throw error;
    }

    return created;
  })();

  try { return await agentCreation; }
  finally { agentCreation = null; }
}

async function disposeAgent(): Promise<void> {
  browserControl?.revoke("Workspace closed"); visibleBrowser?.dispose(); visibleBrowser = undefined; browserControl = undefined;

  if (agentCreation) { try { await agentCreation; } catch {} }

  unsubscribeAgent?.(); unsubscribeAgent = null;
  const current = agentHost; agentHost = null;
  approvedAuthUrls.clear();
  await current?.dispose();
}

function rendererLocation(): string {
  if (process.env.MAUXI_RENDERER_URL) return process.env.MAUXI_RENDERER_URL;

  if (!packagedRenderer) throw new Error("Packaged renderer is not ready");

  return packagedRenderer.url;
}

async function createWindow(partition?: string, workspaceRoot: string | null = null): Promise<BrowserWindow> {
  const previous = mainWindow;
  browserControl?.revoke("Visible window changed"); visibleBrowser?.dispose(); visibleBrowser = undefined; browserControl = undefined;
  currentWorkspaceRoot = workspaceRoot;

  const webPreferences: Electron.WebPreferences = {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
  };

  if (partition) webPreferences.partition = partition;

  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#e9e8e5",
    show: false,
    webPreferences,
  });

  if (previous && !previous.isDestroyed()) retiredCanvasSenders.set(previous.webContents, previous.webContents.mainFrame);
  mainWindow = window;
  captures.clearDrafts(); cleanupCaptureCache();
  const activeWorkspace = manager.snapshot().active;

  if (workspaceRoot && activeWorkspace?.projectRoot === workspaceRoot) {
    installPreviewHeaders(window, {
      workspaceId: activeWorkspace.workspaceId,
      projectOrigin: activeWorkspace.origin,
      rendererUrl: rendererLocation(),
      isActive: () => mainWindow === window && manager.snapshot().active?.workspaceId === activeWorkspace.workspaceId,
    });
  }

  window.on("close", (event) => {
    if (window === mainWindow && manager?.snapshot().active && !quittingAfterCleanup) {
      event.preventDefault();
      app.quit();
    }
  });
  window.on("minimize", () => { if (window === mainWindow) browserControl?.revoke("Window minimized; browser control returned"); });
  window.on("hide", () => { if (window === mainWindow) browserControl?.revoke("Window hidden; browser control returned"); });
  window.webContents.on("render-process-gone", () => {
    if (window !== mainWindow) return;
    captures.clearDrafts(); cleanupCaptureCache();
    browserControl?.revoke("Renderer disconnected");

    if (agentHost) void agentHost.stop(agentHost.workspaceId);
  });
  window.webContents.on("unresponsive", () => browserControl?.revoke("Renderer unresponsive"));
  window.webContents.setWindowOpenHandler(() => { browserControl?.revoke("Popup blocked; control suspended");

  return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, target) => {
    const renderer = rendererLocation();
    const allowed = new URL(target).origin === new URL(renderer).origin;

    if (!allowed) event.preventDefault();
  });

  const previewOriginAllowed = (target: string): boolean => {
    const approved = manager.snapshot().active?.origin;
    const origins = approved ? [new URL(approved).origin] : process.env.MAUXI_PROOF === "1" ? ["http://127.0.0.1:45173", "http://127.0.0.1:45000", "http://127.0.0.1:45001"] : [];

    try { return origins.includes(new URL(target).origin); } catch { return false; }
  };

  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !previewOriginAllowed(event.url)) { event.preventDefault(); browserControl?.revoke("Unexpected origin blocked; control suspended"); }
  });
  window.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame && !previewOriginAllowed(event.url)) { event.preventDefault(); browserControl?.revoke("Unexpected redirect blocked; control suspended"); }
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const cancel = details.resourceType === "subFrame" && !previewOriginAllowed(details.url);

    if (cancel) browserControl?.revoke("Unexpected frame origin blocked; control suspended");
    callback({ cancel });
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once("ready-to-show", () => window.show());
  await window.loadURL(rendererLocation());

  if (previous && !previous.isDestroyed()) previous.destroy();

  return window;
}

function workspacePartition(root: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 24);

  return `persist:mauxi-workspace-${key}`;
}

function registerIpc(): void {
  ipcMain.handle("mauxi:browser-state", event => { assertTrustedSender(event);

  return activeBrowser().state(); });
  ipcMain.handle("mauxi:browser-heartbeat", (event, workspaceId) => {
    assertTrustedSender(event);

    if (!Value.Check(Type.String(), workspaceId) || workspaceId !== browserControl?.workspaceId) throw new Error("Stale browser workspace");
    browserHeartbeat = Date.now();
  });
  ipcMain.handle("mauxi:browser-owner", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(BrowserOwnerInput, input)) throw new Error("Invalid handoff");
    const browser = activeBrowser();

    if (input.workspaceId !== browser.workspaceId) throw new Error("Stale browser workspace");

    if (input.owner === "agent") {
      const generation = browser.state().generation;
      const targets = await browser.targets();
      const shielded = await event.sender.executeJavaScript(`['desktop','mobile'].every(id => { const f=document.querySelector('[data-testid="'+id+'-preview"]'); return f && f.inert && f.tabIndex === -1 && !!f.parentElement.querySelector('[data-browser-shield]'); })`);

      if (!shielded || targets.length !== 2 || browser.state().generation !== generation) throw new Error("Handoff requires two ready, input-shielded visible previews");
      browserHeartbeat = Date.now(); browser.grant();
    } else browser.humanOwner(input.owner);

    return browser.state();
  });
  ipcMain.handle("mauxi:browser-test", async (event, input) => {
    assertTrustedSender(event);

    if (process.env.MAUXI_TEST_MODE !== "1") throw new Error("Test API disabled");
    const browser = activeBrowser();

    if (input === "targets") return { state: browser.state(), targets: await browser.targets() };
    assertBrowserRequest(input);

    return browser.run(input);
  });
  ipcMain.handle("mauxi:get-bootstrap", (event) => {
    assertTrustedSender(event);
    const state = manager.snapshot();

    return { mode: process.env.MAUXI_PROOF === "1" ? "proof" : "project", ...state };
  });

  ipcMain.handle("mauxi:open-project", async (event) => {
    assertTrustedSender(event);
    const defaultPath = await projectPickerLocation.defaultPath(app.getPath("home"));
    const result = await dialog.showOpenDialog(mainWindow!, { title: "Open a local project", defaultPath, properties: ["openDirectory"] });

    if (result.canceled || !result.filePaths[0]) return null;
    const discovery = await manager.inspect(result.filePaths[0]);
    await projectPickerLocation.remember(discovery.canonicalRoot).catch(error => console.warn("Could not save project picker location", error));

    return discovery;
  });

  ipcMain.handle("mauxi:inspect-project-path", async (event, selectedPath) => {
    assertTrustedSender(event);

    if (process.env.MAUXI_TEST_MODE !== "1" || !Value.Check(ProjectPathInput, selectedPath)) throw new Error("Path inspection is test-only");

    return manager.inspect(selectedPath);
  });

  ipcMain.handle("mauxi:confirm-project", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(ConfirmProjectInput, input)) throw new Error("Invalid confirmation");

    try {
      const active = await manager.confirm(input);
      setTimeout(() => { void createWindow(workspacePartition(active.projectRoot), active.projectRoot); }, 100);

      return active;
    } catch (error) {
      const failed = manager.snapshot().active;

      if (failed) setTimeout(() => { void createWindow(workspacePartition(failed.projectRoot), failed.projectRoot); }, 100);
      throw error;
    }
  });

  ipcMain.handle("mauxi:save-canvas", async (event, input) => {
    if (event.senderFrame && retiredCanvasSenders.get(event.sender) === event.senderFrame) return;
    assertTrustedSender(event);

    if (!Value.Check(SaveCanvasInput, input) || !isCanvasState(input.canvas)) throw new Error("Invalid canvas request");
    await manager.saveCanvas(input.workspaceId, input.canvas);
  });

  ipcMain.handle("mauxi:close-project", async (event) => {
    assertTrustedSender(event);
    await disposeAgent();
    const result = await manager.close();
    setTimeout(() => { void createWindow(); }, 100);

    return result;
  });

  ipcMain.handle("mauxi:bridge-ready", (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(BridgeReadyInput, input)) throw new Error("Invalid bridge readiness");
    manager.bridgeReady(input.workspaceId, input.previewId, input.generation, input.url);
  });

  ipcMain.handle("mauxi:resolve-source", async (event, input) => {
    assertTrustedSender(event);
    const active = manager.snapshot().active;

    if (!active) throw new Error("No active workspace");

    if (!Value.Check(SourceRequestInput, input) || input.workspaceId !== active.workspaceId) throw new Error("Invalid source request");

    return resolveWorkspaceSource(active.appRoot, input.hint, input.lineNumber, input.columnNumber, sourceLocator(input.locator));
  });

  ipcMain.handle("mauxi:resolve-fixture-source", async (event, input) => {
    assertTrustedSender(event);

    if (process.env.MAUXI_PROOF !== "1") throw new Error("Proof API disabled");

    if (!Value.Check(FixtureSourceRequestInput, input)) throw new Error("Invalid fixture source request");

    return resolveWorkspaceSource(path.resolve(process.cwd(), "fixtures", input.fixture), input.hint, input.lineNumber, input.columnNumber, sourceLocator(input.locator));
  });

  ipcMain.handle("mauxi:agent-bootstrap", async (event) => {
    assertTrustedSender(event);

    return (await activeAgent()).snapshot();
  });

  ipcMain.handle("mauxi:agent-login", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentLoginInput, input)) throw new Error("Invalid provider setup request");
    await (await activeAgent()).login(input);
  });

  ipcMain.handle("mauxi:agent-logout", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentLogoutInput, input)) throw new Error("Invalid provider logout request");
    await (await activeAgent()).logout(input.workspaceId, input.providerId);
  });

  ipcMain.handle("mauxi:agent-refresh-catalog", async (event, workspaceId) => {
    assertTrustedSender(event);

    if (!Value.Check(WorkspaceIdInput, workspaceId)) throw new Error("Invalid workspace ID");
    await (await activeAgent()).refreshCatalog(workspaceId);
  });

  ipcMain.handle("mauxi:agent-select-model", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentModelInput, input)) throw new Error("Invalid model request");
    await (await activeAgent()).selectModel(input);
  });

  ipcMain.handle("mauxi:agent-set-thinking", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentThinkingInput, input)) throw new Error("Invalid thinking request");
    await (await activeAgent()).setThinking(input);
  });

  ipcMain.handle("mauxi:agent-send", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentSendInput, input)) throw new Error("Invalid agent request");

    let selectionSize = 0;

    try { selectionSize = JSON.stringify(input.selections).length; } catch { throw new Error("Invalid selections"); }

    if (selectionSize > 256_000) throw new Error("Attached context is too large");
    const imagePaths = selectionCapturePaths(input.selections);
    const release = captures.protectInputs(imagePaths);

    try {
      const result = await (await activeAgent()).send(input);

      if (result.accepted) captures.releaseDrafts(imagePaths);

      return result;
    } finally { release(); cleanupCaptureCache(); }
  });

  ipcMain.handle("mauxi:agent-stop", async (event, workspaceId) => {
    assertTrustedSender(event);

    if (!Value.Check(WorkspaceIdInput, workspaceId)) throw new Error("Invalid workspace ID");

    if (browserControl?.workspaceId === workspaceId) browserControl.revoke("Stopped; browser control returned");
    await (await activeAgent()).stop(workspaceId);
  });

  ipcMain.handle("mauxi:agent-dialog-response", async (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(AgentDialogInput, input)) throw new Error("Invalid dialog response");
    (await activeAgent()).respondToDialog(input);
  });

  ipcMain.handle("mauxi:open-auth-url", async (event, target) => {
    assertTrustedSender(event);

    if (!Value.Check(AuthUrlInput, target)) throw new Error("Invalid authentication URL");
    const url = new URL(target);

    if (url.protocol !== "https:" || !approvedAuthUrls.has(url.toString())) throw new Error("Unapproved authentication URL");
    await shell.openExternal(url.toString());
  });

  ipcMain.handle("mauxi:release-captures", (event, input) => {
    assertTrustedSender(event);

    if (!Value.Check(CaptureReleaseInput, input)) throw new Error("Invalid capture release");
    captures.releaseDrafts(input); cleanupCaptureCache();
  });

  ipcMain.handle("mauxi:capture-preview", async (event, input) => {
    assertTrustedSender(event);

    if (!mainWindow) throw new Error("Window unavailable");

    if (!Value.Check(CaptureRequestInput, input)) throw new Error("Invalid capture request");
    assertCaptureBounds(input, mainWindow.getContentBounds());
    const active = manager.snapshot().active;

    if (process.env.MAUXI_PROOF !== "1" && (!active || input.workspaceId !== active.workspaceId)) throw new Error("Stale capture workspace");
    const rect = { x: Math.floor(input.x), y: Math.floor(input.y), width: Math.ceil(input.width), height: Math.ceil(input.height) };
    const image = await mainWindow.webContents.capturePage(rect);
    assertTrustedSender(event);

    if (manager.snapshot().active?.workspaceId !== active?.workspaceId) throw new Error("Workspace changed during capture");
    const outputPath = captures.write(input.previewId, image.toPNG(), input.selectionId);
    const size = image.getSize();

    return { path: outputPath, width: size.width, height: size.height };
  });
}

app.whenReady().then(async () => {
  if (!process.env.MAUXI_RENDERER_URL) packagedRenderer = await startRendererServer(path.join(__dirname, "../dist/renderer"));
  const userData = app.getPath("userData");
  captures = new CaptureCache(process.env.MAUXI_EVIDENCE_DIR ?? path.join(userData, "captures"));
  cleanupCaptureCache();
  captureCleanupTimer = setInterval(cleanupCaptureCache, CAPTURE_RETENTION.cleanupIntervalMs);
  captureCleanupTimer.unref();
  projectPickerLocation = new ProjectPickerLocation(path.join(userData, "project-picker.json"));
  manager = new WorkspaceManager(
    new JournalStore(process.env.MAUXI_STATE_DIR ?? path.join(userData, "recovery")),
    new WorkspaceStore(path.join(userData, "workspaces")),
    path.join(__dirname, "bridge-entry.js"),
  );

  if (process.env.MAUXI_PROOF !== "1") await manager.initialize();
  registerIpc();
  manager.subscribe((state) => {
    const eventRoot = state.active?.projectRoot ?? null;

    if (eventRoot !== currentWorkspaceRoot) return;

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mauxi:workspace-event", state);
  });
  await createWindow();
});

app.on("before-quit", (event) => {
  if (quittingAfterCleanup || !manager?.snapshot().active) return;
  event.preventDefault();

  if (cleanupInProgress) return;
  cleanupInProgress = true;
  void disposeAgent().then(() => manager.close()).then(() => {
    quittingAfterCleanup = true;
    app.quit();
  }).catch(async (error) => {
    cleanupInProgress = false;

    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Cleanup needs attention",
      message: error instanceof Error ? error.message : String(error),
      detail: "Mauxi will preserve its recovery record. Exiting now may leave temporary integration in the project.",
      buttons: ["Keep Mauxi open", "Exit and recover next launch"],
      defaultId: 0,
      cancelId: 0,
    });

    if (choice.response === 1) { quittingAfterCleanup = true; app.quit(); }
  });
});

app.on("window-all-closed", () => app.quit());

app.on("will-quit", () => { clearInterval(captureCleanupTimer); void packagedRenderer?.close(); });
