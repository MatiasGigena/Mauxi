import type {
  ActiveWorkspace,
  ConfirmProjectRequest,
  ProjectDiscovery,
  WorkspaceBootstrap,
  WorkspaceEvent,
} from "../application/project-contract";

import type { CanvasState } from "../application/canvas-state";
import type { AgentDialogResponse, AgentEvent, AgentLoginRequest, AgentModelRequest, AgentSendRequest, AgentSnapshot, AgentThinkingRequest } from "../application/agent-contract";

import type { BrowserOwner, BrowserRequest, BrowserResult, BrowserState, BrowserTarget } from "../application/browser-contract";
import type { AuditProgress, AuditReport, AuditRunRequest, AuditScope, AuditSiteReport, RouteDiscovery } from "../application/audit-contract";

export {};

interface BrowserTestTargets { state: BrowserState; targets: BrowserTarget[] }

type UnsupportedBrowserRequest = Omit<BrowserRequest, "operation"> & { operation: string; expression?: string };

declare global {
  interface Window {
    mauxi?: {
      browserState(): Promise<BrowserState>;
      browserOwner(input: { workspaceId: string; owner: BrowserOwner }): Promise<BrowserState>;
      browserHeartbeat(workspaceId: string): Promise<void>;
      browserTest(input: "targets"): Promise<BrowserTestTargets>;
      browserTest(input: BrowserRequest | UnsupportedBrowserRequest): Promise<BrowserResult>;
      onBrowserState(callback: (state: BrowserState) => void): () => void;
      getBootstrap(): Promise<WorkspaceBootstrap>;
      openProject(): Promise<ProjectDiscovery | null>;
      inspectProjectPath(selectedPath: string): Promise<ProjectDiscovery>;
      confirmProject(input: ConfirmProjectRequest): Promise<ActiveWorkspace>;
      closeProject(): Promise<WorkspaceEvent>;
      saveCanvas(input: { workspaceId: string; canvas: CanvasState }): Promise<void>;
      bridgeReady(input: { workspaceId: string; previewId: "desktop" | "mobile"; generation: string; url: string }): Promise<void>;
      resolveSource(input: { workspaceId: string; hint: string; lineNumber?: number | null; columnNumber?: number | null; locator?: { tag: string; testIds: string[] } }): Promise<{ filePath: string; fileFingerprint: string; lineNumber?: number; columnNumber?: number; method?: "react-grab" | "jsx-attribute" } | null>;
      resolveFixtureSource(input: { fixture: "vite" | "next"; hint: string; lineNumber?: number | null; columnNumber?: number | null; locator?: { tag: string; testIds: string[] } }): Promise<{ filePath: string; fileFingerprint: string; lineNumber?: number; columnNumber?: number; method?: "react-grab" | "jsx-attribute" } | null>;
      capturePreview(input: { workspaceId?: string; previewId: string; selectionId?: string; x: number; y: number; width: number; height: number }): Promise<{ path: string; width: number; height: number }>;
      auditRun(input: AuditRunRequest & { fixture?: "vite" | "next" | "next-turbopack" }): Promise<AuditReport>;
      auditCancel(): Promise<void>;
      auditDiscover(input: AuditScope & { route: string }): Promise<RouteDiscovery>;
      auditSite(input: AuditScope & { routes: string[] }): Promise<AuditSiteReport>;
      auditOpen(input: AuditScope & { route: string }): Promise<AuditReport | null>;
      onAuditSite(callback: (report: AuditSiteReport) => void): () => void;
      onAuditProgress(callback: (progress: AuditProgress) => void): () => void;
      /** A single-route audit started (true) or ended (false), whether the user or the agent started it. */
      onAuditState(callback: (running: boolean) => void): () => void;
      onAuditReport(callback: (report: AuditReport) => void): () => void;
      releaseCaptures(files: string[]): Promise<void>;
      agentBootstrap(): Promise<AgentSnapshot>;
      agentLogin(input: AgentLoginRequest): Promise<void>;
      agentLogout(input: { workspaceId: string; providerId: string }): Promise<void>;
      agentRefreshCatalog(workspaceId: string): Promise<void>;
      agentSelectModel(input: AgentModelRequest): Promise<void>;
      agentSetThinking(input: AgentThinkingRequest): Promise<void>;
      agentSend(input: AgentSendRequest): Promise<{ accepted: boolean }>;
      agentStop(workspaceId: string): Promise<void>;
      agentDialogResponse(input: AgentDialogResponse): Promise<void>;
      openAuthUrl(url: string): Promise<void>;
      openAxeHelp(url: string): Promise<void>;
      onAgentEvent(callback: (event: AgentEvent) => void): () => void;
      onWorkspaceEvent(callback: (event: WorkspaceEvent) => void): () => void;
    };
  }
}
