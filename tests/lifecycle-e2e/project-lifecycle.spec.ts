import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let application: ElectronApplication;
let page: Page;
let originalConfig = "";
const root = path.resolve(".");
const configPath = path.resolve("fixtures/vite/vite.config.ts");

async function portIsFree(): Promise<boolean> {
  try { await fetch("http://127.0.0.1:45173", { signal: AbortSignal.timeout(500) }); return false; }
  catch { return true; }
}

test.beforeAll(async () => {
  originalConfig = await readFile(configPath, "utf8");
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-lifecycle-e2e-"));
  application = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: {
      ...process.env,
      MAUXI_TEST_MODE: "1",
      MAUXI_RENDERER_URL: "http://127.0.0.1:44173",
      MAUXI_STATE_DIR: path.join(state, "recovery"),
      XDG_CONFIG_HOME: path.join(state, "config"),
    },
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await application?.close().catch(() => undefined);
  // The tracked fixture is isolated test data; restore the captured baseline after any failed assertion.
  if (originalConfig) await writeFile(configPath, originalConfig);
});

test("confirms, starts, connects, and safely closes one project", async () => {
  const discovery = await page.evaluate(async (projectRoot) => window.mauxi!.inspectProjectPath(projectRoot), root);
  const plan = discovery.plans.find((candidate) => candidate.appRoot.endsWith("/fixtures/vite"));
  expect(plan, JSON.stringify(discovery.diagnostics)).toBeTruthy();
  expect(plan!.dependenciesPresent).toBe(true);
  expect(plan!.integration.supported).toBe(true);

  const workspaceWindow = application.waitForEvent("window");
  await page.evaluate(async (request) => window.mauxi!.confirmProject(request), {
    discoveryId: discovery.discoveryId,
    planId: plan!.id,
    mode: "start" as const,
  });
  page = await workspaceWindow;
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".connection")).toContainText("Two live previews are connected", { timeout: 45_000 });
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
  const storage = await application.evaluate(({ BrowserWindow, session }) => ({
    workspace: BrowserWindow.getAllWindows()[0].webContents.session.getStoragePath(),
    shellDefault: session.defaultSession.getStoragePath(),
  }));
  expect(storage.workspace).not.toBe(storage.shellDefault);
  expect(await portIsFree()).toBe(false);

  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n// concurrent user edit kept by lifecycle e2e\n`);
  const welcomeWindow = application.waitForEvent("window");
  await page.getByRole("button", { name: "Close project" }).click();
  page = await welcomeWindow;
  await expect(page.getByRole("button", { name: "Open project…" })).toBeVisible();
  await expect.poll(portIsFree, { timeout: 10_000 }).toBe(true);

  const cleaned = await readFile(configPath, "utf8");
  expect(cleaned).not.toContain("mauxi-owned:start preview-bridge");
  expect(cleaned).toContain("concurrent user edit kept by lifecycle e2e");
  await expect(access(path.resolve("fixtures/vite/.mauxi/bridge.js"))).rejects.toThrow();

  await writeFile(configPath, originalConfig);
});
