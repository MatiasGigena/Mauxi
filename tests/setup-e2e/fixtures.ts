import type { Page } from "@playwright/test";
import type { LaunchPlan, ProjectDiscovery } from "../../src/application/project-contract";

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

export async function mockDesktop(page: Page) {
  await page.addInitScript((initial) => {
    const state = { next: initial as typeof initial | null, calls: 0, confirms: [] as unknown[], pending: false, release: null as null | (() => void) };
    (window as unknown as { setupTest: typeof state }).setupTest = state;
    window.mauxi = {
      getBootstrap: async () => ({ mode: "project", active: null, recoveryConflicts: [] }),
      onWorkspaceEvent: () => () => {},
      openProject: async () => {
        state.calls++;
        if (state.pending) await new Promise<void>(resolve => { state.release = resolve; });
        return state.next;
      },
      confirmProject: async (request: unknown) => { state.confirms.push(request); },
    } as unknown as typeof window.mauxi;
  }, discovery());
  await page.goto("/");
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  await page.locator(".project-setup").waitFor();
}
