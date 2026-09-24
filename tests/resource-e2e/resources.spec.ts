import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("native imports require approval, settings stay transient, toggles and explicit invocation work", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-resource-electron-"));
  const source = path.join(state, "skill", "SKILL.md"); await mkdir(path.dirname(source));
  const original = "---\nname: mobile-native\ndescription: Mobile guidance\ndisable-model-invocation: true\n---\nPreserve zoom. Use 16px inputs.\n";
  await writeFile(source, original);
  const config = path.resolve("fixtures/vite/vite.config.ts"); const before = await readFile(config, "utf8");
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let stderr = ""; app.process().stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await writeFile(testInfo.outputPath("electron-startup.json"), JSON.stringify(await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, userData: app.getPath("userData"), name: app.getName() })), null, 2));
    let page = await app.firstWindow();
    const discovery = await page.evaluate(async (root) => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find((candidate) => candidate.appRoot.endsWith("/fixtures/vite"))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Agent settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
    await page.getByText("Design guidance", { exact: true }).click();
    // Only the OS file-picker is stubbed; trusted IPC, approval, loader and UI are real.
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, source);
    await page.getByRole("button", { name: "Import skill…" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Approve local guidance" })).toBeVisible();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(page.locator(".agent-settings")).toContainText("Nothing was enabled");
    expect((await page.evaluate(() => window.mauxi!.agentBootstrap())).resources?.skills).toHaveLength(0);
    await page.getByRole("button", { name: "Import skill…" }).click();
    await page.getByRole("button", { name: "Approve once" }).click();
    await expect(page.locator(".resource-row").first()).toContainText("Ready · automatic");
    expect(await readFile(source, "utf8")).toBe(original);
    await page.locator(".resource-row").first().getByRole("checkbox").uncheck();
    await expect(page.locator(".resource-row").first()).toContainText("Disabled");
    await page.locator(".resource-row").first().getByRole("checkbox").check();
    await expect(page.locator(".resource-row").first()).toContainText("Ready · automatic");
    await page.getByText("Local source & version", { exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("electron-settings.png") });
    await page.getByRole("button", { name: "Use once" }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("/skill:mobile-native ");
    await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).fill("Refine mobile spacing");
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Models & providers", exact: true })).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.locator(".conversation").evaluate(node => getComputedStyle(node).scrollBehavior)).toBe("auto");
    await page.screenshot({ path: testInfo.outputPath("electron-workspace.png") });
    const welcome = app.waitForEvent("window"); await page.getByRole("button", { name: "Close project", exact: true }).click();
    page = await welcome;
    await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
  } finally { await writeFile(testInfo.outputPath("electron-stderr.log"), stderr); await app.close(); await writeFile(config, before); await rm(state, {recursive:true,force:true}); }
});
