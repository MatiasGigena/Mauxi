import { contextBridge, ipcRenderer } from "electron";
import type { ConfirmProjectRequest, WorkspaceEvent } from "../../application/project-contract";

contextBridge.exposeInMainWorld("mauxi", {
  getBootstrap() { return ipcRenderer.invoke("mauxi:get-bootstrap"); },
  openProject() { return ipcRenderer.invoke("mauxi:open-project"); },
  inspectProjectPath(selectedPath: string) { return ipcRenderer.invoke("mauxi:inspect-project-path", selectedPath); },
  confirmProject(input: ConfirmProjectRequest) { return ipcRenderer.invoke("mauxi:confirm-project", input); },
  closeProject() { return ipcRenderer.invoke("mauxi:close-project"); },
  bridgeReady(input: { workspaceId: string; previewId: "desktop" | "mobile"; generation: string; url: string }) {
    return ipcRenderer.invoke("mauxi:bridge-ready", input);
  },
  resolveSource(input: { workspaceId: string; hint: string }) { return ipcRenderer.invoke("mauxi:resolve-source", input); },
  resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string }) {
    return ipcRenderer.invoke("mauxi:resolve-fixture-source", input);
  },
  capturePreview(input: { workspaceId?: string; previewId: string; x: number; y: number; width: number; height: number }) {
    return ipcRenderer.invoke("mauxi:capture-preview", input);
  },
  onWorkspaceEvent(callback: (event: WorkspaceEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: WorkspaceEvent) => callback(value);
    ipcRenderer.on("mauxi:workspace-event", listener);
    return () => ipcRenderer.removeListener("mauxi:workspace-event", listener);
  },
});
