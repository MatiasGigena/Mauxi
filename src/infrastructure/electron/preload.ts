import { contextBridge, ipcRenderer } from "electron";
import type { BrowserOwner, BrowserState } from "../../application/browser-contract";
import type { ResourceToggleRequest } from "../../application/design-resource-contract";
import type { CanvasState } from "../../application/canvas-state";
import type { ConfirmProjectRequest, WorkspaceEvent } from "../../application/project-contract";
import type { AgentDialogResponse, AgentEvent, AgentLoginRequest, AgentModelRequest, AgentRenameRequest, AgentSendRequest, AgentSessionRequest, AgentSnapshot, AgentThinkingRequest, AgentUndoRequest } from "../../application/agent-contract";

contextBridge.exposeInMainWorld("mauxi", {
  browserState(): Promise<BrowserState> { return ipcRenderer.invoke("mauxi:browser-state"); },
  browserOwner(input: { workspaceId: string; owner: BrowserOwner }): Promise<BrowserState> { return ipcRenderer.invoke("mauxi:browser-owner", input); },
  browserHeartbeat(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:browser-heartbeat", workspaceId); },
  browserTest(input: unknown): Promise<unknown> { return ipcRenderer.invoke("mauxi:browser-test", input); },
  onBrowserState(callback: (state: BrowserState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) => callback(state);
    ipcRenderer.on("mauxi:browser-state", listener);
    return () => ipcRenderer.removeListener("mauxi:browser-state", listener);
  },
  getBootstrap() { return ipcRenderer.invoke("mauxi:get-bootstrap"); },
  openProject() { return ipcRenderer.invoke("mauxi:open-project"); },
  inspectProjectPath(selectedPath: string) { return ipcRenderer.invoke("mauxi:inspect-project-path", selectedPath); },
  confirmProject(input: ConfirmProjectRequest) { return ipcRenderer.invoke("mauxi:confirm-project", input); },
  saveCanvas(input: { workspaceId: string; canvas: CanvasState }) { return ipcRenderer.invoke("mauxi:save-canvas", input); },
  closeProject() { return ipcRenderer.invoke("mauxi:close-project"); },
  bridgeReady(input: { workspaceId: string; previewId: "desktop" | "mobile"; generation: string; url: string }) {
    return ipcRenderer.invoke("mauxi:bridge-ready", input);
  },
  resolveSource(input: { workspaceId: string; hint: string; lineNumber?: number | null; columnNumber?: number | null; locator?: { tag: string; testIds: string[] } }) { return ipcRenderer.invoke("mauxi:resolve-source", input); },
  resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string; lineNumber?: number | null; columnNumber?: number | null; locator?: { tag: string; testIds: string[] } }) {
    return ipcRenderer.invoke("mauxi:resolve-fixture-source", input);
  },
  capturePreview(input: { workspaceId?: string; previewId: string; selectionId?: string; x: number; y: number; width: number; height: number }) {
    return ipcRenderer.invoke("mauxi:capture-preview", input);
  },
  agentImportResource(input: { workspaceId: string; kind: "skill" | "catalog" }): Promise<void> { return ipcRenderer.invoke("mauxi:agent-import-resource", input); },
  agentToggleResource(input: ResourceToggleRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-toggle-resource", input); },
  agentBootstrap(): Promise<AgentSnapshot> { return ipcRenderer.invoke("mauxi:agent-bootstrap"); },
  agentLogin(input: AgentLoginRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-login", input); },
  agentLogout(input: { workspaceId: string; providerId: string }): Promise<void> { return ipcRenderer.invoke("mauxi:agent-logout", input); },
  agentRefreshCatalog(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:agent-refresh-catalog", workspaceId); },
  agentSelectModel(input: AgentModelRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-select-model", input); },
  agentSetThinking(input: AgentThinkingRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-set-thinking", input); },
  agentSend(input: AgentSendRequest): Promise<{ accepted: boolean }> { return ipcRenderer.invoke("mauxi:agent-send", input); },
  agentStop(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:agent-stop", workspaceId); },
  agentUndo(input: AgentUndoRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-undo", input); },
  agentNewSession(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:agent-new-session", workspaceId); },
  agentResumeSession(input: AgentSessionRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-resume-session", input); },
  agentRenameSession(input: AgentRenameRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-rename-session", input); },
  agentDialogResponse(input: AgentDialogResponse): Promise<void> { return ipcRenderer.invoke("mauxi:agent-dialog-response", input); },
  openAuthUrl(url: string): Promise<void> { return ipcRenderer.invoke("mauxi:open-auth-url", url); },
  onAgentEvent(callback: (event: AgentEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: AgentEvent) => callback(value);
    ipcRenderer.on("mauxi:agent-event", listener);
    return () => ipcRenderer.removeListener("mauxi:agent-event", listener);
  },
  onWorkspaceEvent(callback: (event: WorkspaceEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: WorkspaceEvent) => callback(value);
    ipcRenderer.on("mauxi:workspace-event", listener);
    return () => ipcRenderer.removeListener("mauxi:workspace-event", listener);
  },
});
