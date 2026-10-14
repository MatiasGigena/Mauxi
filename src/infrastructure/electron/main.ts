import { startRendererServer } from "./renderer-server";
import { installPreviewHeaders } from "./preview-headers";
import { CaptureCache, CAPTURE_RETENTION } from "../storage/capture-cache";
import { selectionCapturePaths } from "../../application/selection-state";
import { app, BrowserWindow, dialog, ipcMain, shell, type Rectangle } from "electron";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceManager } from "../../application/workspace-manager";
import { isCanvasState } from "../../application/canvas-state";
import type { ConfirmProjectRequest } from "../../application/project-contract";
import { assertShortString, isThinkingLevel, type AgentDialogResponse, type AgentLoginRequest, type AgentModelRequest, type AgentSendRequest, type AgentThinkingRequest } from "../../application/agent-contract";
import { PiAgentHost } from "../agent/pi-agent-host";
import { BrowserControl } from "../../application/browser-control";
import { ElectronVisibleBrowser } from "./visible-browser";
import { assertBrowserRequest } from "../../application/browser-contract";
import { JournalStore } from "../instrumentation/journal";
import { WorkspaceStore } from "../project/workspace-store";
import { ProjectPickerLocation } from "../project/project-picker-location";
import { resolveWorkspaceSource } from "../project/source-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

function sourceLocator(value: Record<string, unknown>): { tag: string; testIds: string[] } | undefined {
  if (value.locator === undefined) return undefined;

  if (!value.locator || typeof value.locator !== "object") throw new Error("Invalid source locator");
  const locator = value.locator as Record<string, unknown>;

  if (typeof locator.tag !== "string" || !/^[a-z][\w:-]{0,63}$/i.test(locator.tag)
    || !Array.isArray(locator.testIds) || locator.testIds.length > 12
    || !locator.testIds.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)) throw new Error("Invalid source locator");

  return { tag: locator.tag, testIds: locator.testIds as string[] };
}

function assertCaptureRect(value: unknown, bounds: Rectangle): asserts value is { workspaceId?: string; previewId: string; selectionId?: string; x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object") throw new Error("Invalid capture request");
  const input = value as Record<string, unknown>;

  if (!/^(desktop|mobile)$/.test(String(input.previewId))) throw new Error("Invalid preview ID");

  if (input.selectionId !== undefined && (typeof input.selectionId !== "string" || !/^[\w-]{1,128}$/.test(input.selectionId))) throw new Error("Invalid selection ID");

  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof input[key] !== "number" || !Number.isFinite(input[key])) throw new Error(`Invalid ${key}`);
  }

  const x = Number(input.x); const y = Number(input.y);
  const width = Number(input.width); const height = Number(input.height);

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

  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#e9e8e5",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      ...(partition ? { partition } : {}),
    },
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
  ipcMain.handle("mauxi:browser-heartbeat", (event, workspaceId: unknown) => {
    assertTrustedSender(event);

    if (workspaceId !== browserControl?.workspaceId) throw new Error("Stale browser workspace");
    browserHeartbeat = Date.now();
  });
  ipcMain.handle("mauxi:browser-owner", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid handoff");
    const value = input as Record<string, unknown>; const browser = activeBrowser();

    if (value.workspaceId !== browser.workspaceId) throw new Error("Stale browser workspace");

    if (value.owner === "agent") {
      const generation = browser.state().generation;
      const targets = await browser.targets();
      const shielded = await event.sender.executeJavaScript(`['desktop','mobile'].every(id => { const f=document.querySelector('[data-testid="'+id+'-preview"]'); return f && f.inert && f.tabIndex === -1 && !!f.parentElement.querySelector('[data-browser-shield]'); })`);

      if (!shielded || targets.length !== 2 || browser.state().generation !== generation) throw new Error("Handoff requires two ready, input-shielded visible previews");
      browserHeartbeat = Date.now(); browser.grant();
    } else if (value.owner === "human" || value.owner === "picker") browser.humanOwner(value.owner);
    else throw new Error("Invalid browser owner");

    return browser.state();
  });
  ipcMain.handle("mauxi:browser-test", async (event, input: unknown) => {
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

  ipcMain.handle("mauxi:inspect-project-path", async (event, selectedPath: unknown) => {
    assertTrustedSender(event);

    if (process.env.MAUXI_TEST_MODE !== "1" || typeof selectedPath !== "string" || selectedPath.length > 4_096) throw new Error("Path inspection is test-only");

    return manager.inspect(selectedPath);
  });

  ipcMain.handle("mauxi:confirm-project", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid confirmation");
    const value = input as Record<string, unknown>;

    if (typeof value.discoveryId !== "string" || value.discoveryId.length > 128 || typeof value.planId !== "string" || value.planId.length > 128 || (value.mode !== "start" && value.mode !== "attach")) throw new Error("Invalid confirmation");

    try {
      const active = await manager.confirm(value as unknown as ConfirmProjectRequest);
      setTimeout(() => { void createWindow(workspacePartition(active.projectRoot), active.projectRoot); }, 100);

      return active;
    } catch (error) {
      const failed = manager.snapshot().active;

      if (failed) setTimeout(() => { void createWindow(workspacePartition(failed.projectRoot), failed.projectRoot); }, 100);
      throw error;
    }
  });

  ipcMain.handle("mauxi:save-canvas", async (event, input: unknown) => {
    if (event.senderFrame && retiredCanvasSenders.get(event.sender) === event.senderFrame) return;
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid canvas request");
    const value = input as Record<string, unknown>;

    if (typeof value.workspaceId !== "string" || value.workspaceId.length > 128 || !isCanvasState(value.canvas)) throw new Error("Invalid canvas request");
    await manager.saveCanvas(value.workspaceId, value.canvas);
  });

  ipcMain.handle("mauxi:close-project", async (event) => {
    assertTrustedSender(event);
    await disposeAgent();
    const result = await manager.close();
    setTimeout(() => { void createWindow(); }, 100);

    return result;
  });

  ipcMain.handle("mauxi:bridge-ready", (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid bridge readiness");
    const value = input as Record<string, unknown>;

    if (typeof value.workspaceId !== "string" || value.workspaceId.length > 128 || (value.previewId !== "desktop" && value.previewId !== "mobile") || typeof value.generation !== "string" || value.generation.length > 128 || typeof value.url !== "string" || value.url.length > 4_096) throw new Error("Invalid bridge readiness");
    manager.bridgeReady(value.workspaceId, value.previewId, value.generation, value.url);
  });

  ipcMain.handle("mauxi:resolve-source", async (event, input: unknown) => {
    assertTrustedSender(event);
    const active = manager.snapshot().active;

    if (!active || !input || typeof input !== "object") throw new Error("No active workspace");
    const value = input as Record<string, unknown>;

    if (value.workspaceId !== active.workspaceId || typeof value.hint !== "string" || value.hint.length > 1_024) throw new Error("Invalid source request");

    if (value.lineNumber !== undefined && value.lineNumber !== null && (typeof value.lineNumber !== "number" || !Number.isInteger(value.lineNumber))) throw new Error("Invalid source line");

    if (value.columnNumber !== undefined && value.columnNumber !== null && (typeof value.columnNumber !== "number" || !Number.isInteger(value.columnNumber))) throw new Error("Invalid source column");

    return resolveWorkspaceSource(active.appRoot, value.hint, value.lineNumber as number | null | undefined, value.columnNumber as number | null | undefined, sourceLocator(value));
  });

  ipcMain.handle("mauxi:resolve-fixture-source", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (process.env.MAUXI_PROOF !== "1" || !input || typeof input !== "object") throw new Error("Proof API disabled");
    const value = input as Record<string, unknown>;

    if ((value.fixture !== "vite" && value.fixture !== "next") || typeof value.hint !== "string" || value.hint.length > 1_024) throw new Error("Invalid fixture source request");

    if (value.lineNumber !== undefined && value.lineNumber !== null && (typeof value.lineNumber !== "number" || !Number.isInteger(value.lineNumber))) throw new Error("Invalid source line");

    if (value.columnNumber !== undefined && value.columnNumber !== null && (typeof value.columnNumber !== "number" || !Number.isInteger(value.columnNumber))) throw new Error("Invalid source column");

    return resolveWorkspaceSource(path.resolve(process.cwd(), "fixtures", value.fixture), value.hint, value.lineNumber as number | null | undefined, value.columnNumber as number | null | undefined, sourceLocator(value));
  });

  ipcMain.handle("mauxi:agent-bootstrap", async (event) => {
    assertTrustedSender(event);

    return (await activeAgent()).snapshot();
  });

  ipcMain.handle("mauxi:agent-login", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid provider setup request");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128); assertShortString(value.providerId, "provider ID", 200);

    if (value.type !== "api_key" && value.type !== "oauth") throw new Error("Invalid authentication type");
    await (await activeAgent()).login(value as unknown as AgentLoginRequest);
  });

  ipcMain.handle("mauxi:agent-logout", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid provider logout request");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128); assertShortString(value.providerId, "provider ID", 200);
    await (await activeAgent()).logout(value.workspaceId, value.providerId);
  });

  ipcMain.handle("mauxi:agent-refresh-catalog", async (event, workspaceId: unknown) => {
    assertTrustedSender(event); assertShortString(workspaceId, "workspace ID", 128);
    await (await activeAgent()).refreshCatalog(workspaceId);
  });

  ipcMain.handle("mauxi:agent-select-model", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid model request");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128); assertShortString(value.modelKey, "model key", 500);
    await (await activeAgent()).selectModel(value as unknown as AgentModelRequest);
  });

  ipcMain.handle("mauxi:agent-set-thinking", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid thinking request");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128);

    if (!isThinkingLevel(value.level)) throw new Error("Invalid thinking level");
    await (await activeAgent()).setThinking(value as unknown as AgentThinkingRequest);
  });

  ipcMain.handle("mauxi:agent-send", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid agent request");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128); assertShortString(value.text, "message", 100_000);

    if (value.behavior !== "prompt" && value.behavior !== "steer" && value.behavior !== "followUp") throw new Error("Invalid message behavior");

    if (!Array.isArray(value.selections) || value.selections.length > 8) throw new Error("Invalid selections");
    let selectionSize = 0;

 try { selectionSize = JSON.stringify(value.selections).length; } catch { throw new Error("Invalid selections"); }

    if (selectionSize > 256_000) throw new Error("Attached context is too large");
    const request = value as unknown as AgentSendRequest;
    const imagePaths = selectionCapturePaths(request.selections);
    const release = captures.protectInputs(imagePaths);

    try {
      const result = await (await activeAgent()).send(request);

      if (result.accepted) captures.releaseDrafts(imagePaths);

      return result;
    } finally { release(); cleanupCaptureCache(); }
  });

  ipcMain.handle("mauxi:agent-stop", async (event, workspaceId: unknown) => {
    assertTrustedSender(event); assertShortString(workspaceId, "workspace ID", 128);

    if (browserControl?.workspaceId === workspaceId) browserControl.revoke("Stopped; browser control returned");
    await (await activeAgent()).stop(workspaceId);
  });

  ipcMain.handle("mauxi:agent-dialog-response", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!input || typeof input !== "object") throw new Error("Invalid dialog response");
    const value = input as Record<string, unknown>;
    assertShortString(value.workspaceId, "workspace ID", 128); assertShortString(value.dialogId, "dialog ID", 128);

    if (value.value !== undefined) assertShortString(value.value, "dialog value", 8_000);

    if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") throw new Error("Invalid dialog response");
    (await activeAgent()).respondToDialog(value as unknown as AgentDialogResponse);
  });

  ipcMain.handle("mauxi:open-auth-url", async (event, target: unknown) => {
    assertTrustedSender(event); assertShortString(target, "authentication URL", 4_096);
    const url = new URL(target);

    if (url.protocol !== "https:" || !approvedAuthUrls.has(url.toString())) throw new Error("Unapproved authentication URL");
    await shell.openExternal(url.toString());
  });

  ipcMain.handle("mauxi:release-captures", (event, input: unknown) => {
    assertTrustedSender(event);

    if (!Array.isArray(input) || input.length > 8 || !input.every(file => typeof file === "string" && file.length > 0 && file.length <= 4_096)) throw new Error("Invalid capture release");
    captures.releaseDrafts(input); cleanupCaptureCache();
  });

  ipcMain.handle("mauxi:capture-preview", async (event, input: unknown) => {
    assertTrustedSender(event);

    if (!mainWindow) throw new Error("Window unavailable");
    const bounds = mainWindow.getContentBounds();
    assertCaptureRect(input, bounds);
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
