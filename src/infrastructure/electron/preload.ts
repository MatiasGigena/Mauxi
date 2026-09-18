import { contextBridge, ipcRenderer } from "electron";
import type { CanvasState } from "../../application/canvas-state";
import type { ConfirmProjectRequest, WorkspaceEvent } from "../../application/project-contract";

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
  onWorkspaceEvent(callback: (event: WorkspaceEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: WorkspaceEvent) => callback(value);
    ipcRenderer.on("mauxi:workspace-event", listener);
    return () => ipcRenderer.removeListener("mauxi:workspace-event", listener);
  },
});
