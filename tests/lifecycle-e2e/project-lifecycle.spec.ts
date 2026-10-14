import { toggleRoutes, closeProject, expectRoutes } from "../helpers/workspace-controls";
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
  try { await fetch("http://127.0.0.1:45173", { signal: AbortSignal.timeout(500) });

  return false; }
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
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });

  const storage = await application.evaluate(({ BrowserWindow, session }) => ({
    workspace: BrowserWindow.getAllWindows()[0].webContents.session.getStoragePath(),
    shellDefault: session.defaultSession.getStoragePath(),
  }));

  expect(storage.workspace).not.toBe(storage.shellDefault);
  expect(await portIsFree()).toBe(false);

  await toggleRoutes(page, true);
  await page.getByRole("button", { name: "Move Mobile artboard with arrow keys" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await page.getByLabel("Width", { exact: true }).fill("420");
  await page.getByRole("button", { name: "Apply viewport", exact: true }).click();
  await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
  await page.getByRole("button", { name: "Focus Mobile", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await window.mauxi!.getBootstrap()).active?.canvas?.focus?.previewId)).toBe("mobile");
  const saved = await page.evaluate(async () => (await window.mauxi!.getBootstrap()).active!.canvas!);
  expect(saved).toMatchObject({ linked: false, boards: { mobile: { width: 420 } } });

  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n// concurrent user edit kept by lifecycle e2e\n`);
  const welcomeWindow = application.waitForEvent("window");
  await closeProject(page);
  page = await welcomeWindow;
  await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
  await expect.poll(portIsFree, { timeout: 10_000 }).toBe(true);

  const cleaned = await readFile(configPath, "utf8");
  expect(cleaned).not.toContain("mauxi-owned:start preview-bridge");
  expect(cleaned).toContain("concurrent user edit kept by lifecycle e2e");
  await expect(access(path.resolve("fixtures/vite/.mauxi/bridge.js"))).rejects.toThrow();

  await writeFile(configPath, originalConfig);
  const reopened = await page.evaluate(async (projectRoot) => window.mauxi!.inspectProjectPath(projectRoot), root);
  expect(reopened.rememberedPlanId).toBe(plan!.id);
  const reopenedWindow = application.waitForEvent("window");
  await page.evaluate(async (request) => window.mauxi!.confirmProject(request), { discoveryId: reopened.discoveryId, planId: reopened.rememberedPlanId!, mode: "start" as const });
  page = await reopenedWindow;
  await expect(page.getByRole("button", { name: "Unfocus Mobile", exact: true })).toBeVisible();
  await expectRoutes(page, false, "Mobile");
  await expect(page.getByTestId("mobile-preview")).toHaveAttribute("width", "420");
  const restored = await page.evaluate(async () => (await window.mauxi!.getBootstrap()).active!.canvas!);
  expect(restored.boards).toEqual(saved.boards); expect(restored.focus).toEqual(saved.focus);
  await page.getByRole("button", { name: "Unfocus Mobile", exact: true }).click();
  const secondWelcome = application.waitForEvent("window");
  await closeProject(page);
  page = await secondWelcome;
  await expect.poll(portIsFree, { timeout: 10_000 }).toBe(true);
});
