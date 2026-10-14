import { closeProject } from "../helpers/workspace-controls";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("references load in the background without design setup or controls", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-resource-electron-"));
  const config = path.resolve("fixtures/vite/vite.config.ts"); const before = await readFile(config, "utf8");
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let stderr = ""; app.process().stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    let page = await app.firstWindow();
    const discovery = await page.evaluate(async (root) => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find((candidate) => candidate.appRoot.endsWith("/fixtures/vite"))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });

    const agent = await page.evaluate(() => window.mauxi!.agentBootstrap());
    expect(agent.ready).toBe(true);
    for (const key of ["resources", "sessions", "changeSets", "tools"]) expect(agent).not.toHaveProperty(key);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    await expect(page.locator(".chat-settings")).toBeVisible();
    await expect(page.getByText(/Design guidance|Design direction|Local source & version/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Import skill|Choose visual library|Use once/ })).toHaveCount(0);
    await expect(page.locator(".resource-row")).toHaveCount(0);
    expect(await page.evaluate(() => "agentImportResource" in window.mauxi! || "agentToggleResource" in window.mauxi!)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("background-guidance-settings.png") });
    await page.getByRole("button", { name: "Close models and providers" }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    const welcome = app.waitForEvent("window"); await closeProject(page);
    page = await welcome;
    await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
  } finally {
    await writeFile(testInfo.outputPath("electron-stderr.log"), stderr);
    await app.close(); await writeFile(config, before); await rm(state, { recursive: true, force: true });
  }
});
