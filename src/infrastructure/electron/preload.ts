import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mauxi", {
  resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string }) {
    return ipcRenderer.invoke("mauxi:resolve-fixture-source", input);
  },
  capturePreview(input: { previewId: string; x: number; y: number; width: number; height: number }) {
    return ipcRenderer.invoke("mauxi:capture-preview", input);
  },
});
