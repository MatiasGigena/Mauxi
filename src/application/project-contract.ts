import type { CanvasState } from "./canvas-state";

export type SupportedFramework = "vite" | "next";
export type SupportedPackageManager = "npm" | "pnpm" | "yarn";
export type WorkspaceStatus =
  | "idle"
  | "preparing"
  | "starting"
  | "waiting-for-server"
  | "connecting-previews"
  | "ready"
  | "failed"
  | "stopped";

export interface ProjectDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface IntegrationPreview {
  supported: boolean;
  summary: string;
  files: Array<{ path: string; action: "modify" | "create"; diff: string }>;
}

export interface LaunchPlan {
  id: string;
  label: string;
  projectRoot: string;
  appRoot: string;
  framework: SupportedFramework;
  packageManager: SupportedPackageManager;
  scriptName: string;
  scriptCommand: string;
  configurationFingerprint: string;
  commandDisplay: string;
  executable: string;
  args: string[];
  origin: string;
  startPath?: string;
  port: number;
  dependenciesPresent: boolean;
  integration: IntegrationPreview;
  diagnostics: ProjectDiagnostic[];
}

export interface ProjectDiscovery {
  discoveryId: string;
  selectedRoot: string;
  canonicalRoot: string;
  packageJsonPath: string | null;
  git: { repository: boolean; dirty: boolean | null };
  plans: LaunchPlan[];
  rememberedPlanId: string | null;
  diagnostics: ProjectDiagnostic[];
}

export interface ActiveWorkspace {
  canvas?: CanvasState | null;
  workspaceId: string;
  projectRoot: string;
  appRoot: string;
  framework: SupportedFramework;
  packageManager: SupportedPackageManager;
  commandDisplay: string;
  origin: string;
  startPath?: string;
  ownership: "owned" | "attached";
  status: WorkspaceStatus;
  statusDetail: string;
  logs: string[];
  connectedPreviews: Array<"desktop" | "mobile">;
  cleanupConflicts: string[];
}

export interface WorkspaceBootstrap {
  mode: "project" | "proof";
  active: ActiveWorkspace | null;
  recoveryConflicts: string[];
}

export interface WorkspaceEvent {
  active: ActiveWorkspace | null;
  recoveryConflicts: string[];
}

export interface ConfirmProjectRequest {
  discoveryId: string;
  planId: string;
  mode: "start" | "attach";
}
