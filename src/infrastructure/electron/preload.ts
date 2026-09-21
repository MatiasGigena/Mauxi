import { contextBridge, ipcRenderer } from "electron";
import type { CanvasState } from "../../application/canvas-state";
import type { ConfirmProjectRequest, WorkspaceEvent } from "../../application/project-contract";
import type { AgentDialogResponse, AgentEvent, AgentLoginRequest, AgentModelRequest, AgentRenameRequest, AgentSendRequest, AgentSessionRequest, AgentSnapshot, AgentThinkingRequest } from "../../application/agent-contract";

contextBridge.exposeInMainWorld("mauxi", {
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
  agentBootstrap(): Promise<AgentSnapshot> { return ipcRenderer.invoke("mauxi:agent-bootstrap"); },
  agentLogin(input: AgentLoginRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-login", input); },
  agentLogout(input: { workspaceId: string; providerId: string }): Promise<void> { return ipcRenderer.invoke("mauxi:agent-logout", input); },
  agentRefreshCatalog(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:agent-refresh-catalog", workspaceId); },
  agentSelectModel(input: AgentModelRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-select-model", input); },
  agentSetThinking(input: AgentThinkingRequest): Promise<void> { return ipcRenderer.invoke("mauxi:agent-set-thinking", input); },
  agentSend(input: AgentSendRequest): Promise<{ accepted: boolean }> { return ipcRenderer.invoke("mauxi:agent-send", input); },
  agentStop(workspaceId: string): Promise<void> { return ipcRenderer.invoke("mauxi:agent-stop", workspaceId); },
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
