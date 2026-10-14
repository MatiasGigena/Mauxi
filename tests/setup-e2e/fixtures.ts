import type { Page } from "@playwright/test";
import type { AgentEvent } from "../../src/application/agent-contract";
import type { ActiveWorkspace, ConfirmProjectRequest, LaunchPlan, ProjectDiscovery, WorkspaceEvent } from "../../src/application/project-contract";

export interface SetupTest {
  next: ProjectDiscovery | null;
  calls: number;
  confirms: ConfirmProjectRequest[];
  pending: boolean;
  release: null | (() => void);
  confirmPending: boolean;
  confirmRelease: null | (() => void);
  confirmError: boolean;
  agentListeners: Array<(event: AgentEvent) => void>;
  workspaceListeners: Array<(event: WorkspaceEvent) => void>;
}

declare global {
  interface Window { setupTest?: SetupTest }
}

export function discovery(): ProjectDiscovery {
  const vite: LaunchPlan = {
    id: "vite-dev", label: "rondo — dev", projectRoot: "/projects/rondo", appRoot: "/projects/rondo",
    framework: "vite", packageManager: "npm", scriptName: "dev", scriptCommand: "vite",
    configurationFingerprint: "vite-fingerprint", commandDisplay: "npm run dev", executable: "npm", args: ["run", "dev"],
    origin: "http://127.0.0.1:5173", port: 5173, dependenciesPresent: true, diagnostics: [],
    integration: { supported: true, summary: "Development-only bridge.", files: [
      { action: "modify", path: "vite.config.ts", diff: "--- vite.config.ts\n+++ vite.config.ts\n- old config\n+ new config\n  context" },
      { action: "create", path: ".mauxi/launcher.cjs", diff: "+ temporary launcher" },
      { action: "create", path: ".mauxi/runtime/", diff: "+ runtime" },
      { action: "create", path: ".mauxi/bridge.js", diff: "+ preview bridge" },
    ] },
  };

  return {
    discoveryId: "first-discovery", selectedRoot: "/projects/rondo", canonicalRoot: "/projects/rondo", packageJsonPath: "/projects/rondo/package.json",
    git: { repository: true, dirty: false }, rememberedPlanId: null, diagnostics: [], plans: [vite, {
      ...vite, id: "next-start", label: "storefront — start", appRoot: "/projects/rondo/storefront", framework: "next", packageManager: "pnpm",
      scriptName: "start", scriptCommand: "next dev", commandDisplay: "pnpm run start", origin: "http://127.0.0.1:3000", port: 3000,
      integration: { supported: true, summary: "Next.js client integration.", files: [{ action: "create", path: "instrumentation-client.ts", diff: "+ import './.mauxi/bridge'" }] },
    }],
  };
}

export async function selectScript(page: Page, command: string) {
  await page.getByRole("combobox", { name: /Application and script/ }).click();
  await page.getByRole("option").filter({ has: page.getByText(command, { exact: true }) }).click();
}

export async function mockDesktop(page: Page) {
  await page.context().route("http://127.0.0.1:5173/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Test preview</title><body>Test preview</body>" }));
  await page.addInitScript((initial) => {
    const state: SetupTest = { next: initial, calls: 0, confirms: [], pending: false, release: null, confirmPending: false, confirmRelease: null, confirmError: false, agentListeners: [], workspaceListeners: [] };
    const unmocked = () => { throw new TypeError("This desktop API is not mocked"); };

    window.setupTest = state;
    window.mauxi = {
      getBootstrap: async () => ({ mode: "project", active: null, recoveryConflicts: [] }),
      onWorkspaceEvent: listener => { state.workspaceListeners.push(listener);

      return () => { state.workspaceListeners = state.workspaceListeners.filter(item => item !== listener); }; },
      onAgentEvent: listener => { state.agentListeners.push(listener);

      return () => { state.agentListeners = state.agentListeners.filter((item) => item !== listener); }; },
      agentBootstrap: () => new Promise(() => {}),
      onBrowserState: () => () => {},
      browserState: async () => ({ workspaceId: "test-workspace", owner: "human", generation: 0, releasing: false, activity: "", remaining: 0, evidence: [] }),
      browserHeartbeat: async () => {},
      browserOwner: async () => ({ workspaceId: "test-workspace", owner: "human", generation: 0, releasing: false, activity: "", remaining: 0, evidence: [] }),
      saveCanvas: async () => {},
      releaseCaptures: async () => {},
      openProject: async () => {
        state.calls++;

        if (state.pending) await new Promise<void>(resolve => { state.release = resolve; });

        return state.next;
      },
      confirmProject: async request => {
        state.confirms.push(request);

        if (state.confirmPending) await new Promise<void>(resolve => { state.confirmRelease = resolve; });

        if (state.confirmError) throw new Error("Setup failed");

        return {
          workspaceId: "test-workspace", projectRoot: "/projects/rondo", appRoot: "/projects/rondo",
          framework: "vite", packageManager: "npm", commandDisplay: "npm run dev", origin: "http://127.0.0.1:5173",
          ownership: "owned", status: "connecting-previews", statusDetail: "Waiting for previews…",
          logs: [], connectedPreviews: [], cleanupConflicts: [],
        } satisfies ActiveWorkspace;
      },
      browserTest: unmocked,
      inspectProjectPath: unmocked,
      closeProject: unmocked,
      bridgeReady: unmocked,
      resolveSource: unmocked,
      resolveFixtureSource: unmocked,
      capturePreview: unmocked,
      agentLogin: unmocked,
      agentLogout: unmocked,
      agentRefreshCatalog: unmocked,
      agentSelectModel: unmocked,
      agentSetThinking: unmocked,
      agentSend: unmocked,
      agentStop: unmocked,
      agentDialogResponse: unmocked,
      openAuthUrl: unmocked,
    };
  }, discovery());
  await page.goto("/");
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  await page.locator(".project-setup").waitFor();
}
