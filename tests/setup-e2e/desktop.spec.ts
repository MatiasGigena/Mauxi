import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectScript } from "./fixtures";

test("desktop opens the native directory dialog via IPC, inspects real folders and preserves selection on cancel", async ({}, testInfo) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mauxi-setup-desktop-"));
  const first = path.join(temp, "first-project");
  const second = path.join(temp, "second-project");
  for (const folder of [first, second]) {
    await mkdir(folder);
    await writeFile(path.join(folder, "package.json"), JSON.stringify({ name: path.basename(folder), scripts: { dev: "vite", "dev:host": "vite --host" }, devDependencies: { vite: "7.3.6" }, dependencies: { react: "19.3.0" } }));
    await writeFile(path.join(folder, "vite.config.ts"), 'import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });\n');
    await symlink(path.resolve("node_modules"), path.join(folder, "node_modules"), "dir");
  }
  const launchOptions = {
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_PROOF: "0", MAUXI_RENDERER_URL: "", MAUXI_STATE_DIR: path.join(temp, "recovery"), XDG_CONFIG_HOME: path.join(temp, "config") },
  };
  let application = await electron.launch(launchOptions);
  try {
    // Substitute only the OS dialog result; preload, trusted IPC, discovery and UI are real.
    await application.evaluate(({ dialog }, folders) => {
      const selections: Array<string | null> = [folders.first, null, folders.second];
      (globalThis as any).setupDialogCalls = [];
      Object.assign(dialog, { showOpenDialog: async (_window: unknown, options: unknown) => {
        (globalThis as any).setupDialogCalls.push(options);
        const selected = selections.shift();
        return { canceled: !selected, filePaths: selected ? [selected] : [] };
      } });
    }, { first, second });
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    await expect(page.locator(".guided-intro h2")).toHaveText("Let’s work on first-project.");
    await expect(page.locator(".project-path")).toHaveText(first);
    await expect(page.locator(".proto-picker, input[type=file], dialog")).toHaveCount(0);
    await page.locator(".configure-trigger").click();
    await selectScript(page, "npm run dev:host");
    await expect(page.locator(".configure-trigger small")).toHaveText("npm run dev:host");
    await page.keyboard.press("Escape");
    await page.locator(".change-project").click();
    await expect(page.locator(".change-project")).toBeEnabled();
    await expect(page.locator(".project-path")).toHaveText(first);
    await expect(page.locator(".configure-trigger small")).toHaveText("npm run dev:host");
    await page.locator(".change-project").click();
    await expect(page.locator(".guided-intro h2")).toHaveText("Let’s work on second-project.");
    await expect(page.locator(".project-path")).toHaveText(second);
    await page.locator(".review-trigger").click();
    await expect(page.locator(".guided-file-trigger")).toHaveCount(4);
    await page.locator(".guided-file-trigger").first().click();
    await expect(page.locator(".guided-file-panel[aria-hidden=false]")).toContainText("mauxi");
    await page.waitForFunction(() => !document.querySelector('.project-setup')!.getAnimations({ subtree: true }).some(animation => animation.effect!.getTiming().iterations !== Infinity && animation.playState === 'running'));
    await page.screenshot({ path: testInfo.outputPath("desktop-integration.png") });
    const calls = await application.evaluate(() => (globalThis as any).setupDialogCalls);
    expect(calls).toHaveLength(3);
    expect(calls.every((call: { properties: string[] }) => JSON.stringify(call.properties) === '["openDirectory"]')).toBe(true);
    const home = await application.evaluate(({ app }) => app.getPath("home"));
    expect(calls.map((call: { defaultPath: string }) => call.defaultPath)).toEqual([home, first, first]);
    expect(errors).toEqual([]);

    // A new Electron process must remember the last folder, not the cancelled selection.
    await application.close();
    application = await electron.launch(launchOptions);
    await application.evaluate(({ dialog }) => {
      Object.assign(dialog, { showOpenDialog: async (_window: unknown, options: unknown) => {
        (globalThis as any).restartedDialogOptions = options;
        return { canceled: true, filePaths: [] };
      } });
    });
    const restartedPage = await application.firstWindow();
    await restartedPage.getByRole("button", { name: "Open Project", exact: true }).click();
    await expect(restartedPage.getByRole("button", { name: "Open Project", exact: true })).toBeEnabled();
    expect(await application.evaluate(() => (globalThis as any).restartedDialogOptions.defaultPath)).toBe(second);
  } finally {
    await application.close();
    await rm(temp, { recursive: true, force: true });
  }
});
