import type {
  ActiveWorkspace,
  ConfirmProjectRequest,
  ProjectDiscovery,
  WorkspaceBootstrap,
  WorkspaceEvent,
} from "../application/project-contract";

import type { CanvasState } from "../application/canvas-state";

export {};

declare global {
  interface Window {
    mauxi?: {
      getBootstrap(): Promise<WorkspaceBootstrap>;
      openProject(): Promise<ProjectDiscovery | null>;
      inspectProjectPath(selectedPath: string): Promise<ProjectDiscovery>;
      confirmProject(input: ConfirmProjectRequest): Promise<ActiveWorkspace>;
      closeProject(): Promise<WorkspaceEvent>;
      saveCanvas(input: { workspaceId: string; canvas: CanvasState }): Promise<void>;
      bridgeReady(input: { workspaceId: string; previewId: "desktop" | "mobile"; generation: string; url: string }): Promise<void>;
      resolveSource(input: { workspaceId: string; hint: string }): Promise<{ filePath: string; fileFingerprint: string } | null>;
      resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string }): Promise<{ filePath: string; fileFingerprint: string } | null>;
      capturePreview(input: { workspaceId?: string; previewId: string; x: number; y: number; width: number; height: number }): Promise<{ path: string; width: number; height: number }>;
      onWorkspaceEvent(callback: (event: WorkspaceEvent) => void): () => void;
    };
  }
}
