import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultCanvas } from "../../src/application/canvas-state";

declare global {
  var releaseReplacement: (() => void) | undefined;
}

test("window handoff discards old layout saves without trusting unrelated IPC senders", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mauxi-canvas-handoff-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "handoff-test", scripts: { dev: "vite" }, devDependencies: { vite: "7.3.6" }, dependencies: { react: "19.3.0" } }));
  await writeFile(path.join(project, "vite.config.ts"), 'import { defineConfig } from "vite"; export default defineConfig({ plugins: [] });');
  await writeFile(path.join(project, "index.html"), '<html><body>Canvas handoff test</body></html>');
  await symlink(path.resolve("node_modules"), path.join(project, "node_modules"), "dir");

  const app = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_PROOF: "0", MAUXI_RENDERER_URL: "", MAUXI_STATE_DIR: path.join(temp, "recovery"), XDG_CONFIG_HOME: path.join(temp, "config") },
  });

  let stderr = "";
  app.process().stderr?.on("data", chunk => { stderr += String(chunk); });

  try {
    const oldPage = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const original = BrowserWindow.prototype.loadURL;
      BrowserWindow.prototype.loadURL = async function (...args) {
        BrowserWindow.prototype.loadURL = original;
        await new Promise<void>(resolve => { globalThis.releaseReplacement = resolve; });

        return original.apply(this, args);
      };
    });
    const discovery = await oldPage.evaluate(root => window.mauxi!.inspectProjectPath(root), project);
    const next = app.waitForEvent("window");
    const active = await oldPage.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" as const });
    await expect.poll(() => app.evaluate(() => !!globalThis.releaseReplacement)).toBe(true);
    const stale = defaultCanvas(); stale.camera.x = 987654;
    await oldPage.evaluate(input => window.mauxi!.saveCanvas(input), { workspaceId: active.workspaceId, canvas: stale });
    expect(stderr).not.toContain("Untrusted IPC sender");
    await app.evaluate(() => globalThis.releaseReplacement!());
    const page = await next;
    await expect(page.getByRole("button", { name: "Models & providers", exact: true })).toBeVisible();
    const restored = await page.evaluate(() => window.mauxi!.getBootstrap());
    expect(restored.active?.canvas?.camera.x).not.toBe(987654);

    const current = defaultCanvas(); current.camera.x = 123456;
    await page.evaluate(input => window.mauxi!.saveCanvas(input), { workspaceId: active.workspaceId, canvas: current });
    expect((await page.evaluate(() => window.mauxi!.getBootstrap())).active?.canvas?.camera.x).toBe(123456);

    const rejection = await app.evaluate(async ({ BrowserWindow }, { preload, input }) => {
      const rogue = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });

      try {
        await rogue.loadURL("data:text/html,<title>Untrusted renderer</title>");

        return await rogue.webContents.executeJavaScript(`window.mauxi.saveCanvas(${JSON.stringify(input)}).then(() => "accepted", error => error.message)`);
      } finally { rogue.destroy(); }
    }, { preload: path.resolve("dist-electron/preload.cjs"), input: { workspaceId: active.workspaceId, canvas: stale } });

    expect(rejection).toContain("Untrusted IPC sender");
  } finally {
    await app.evaluate(() => globalThis.releaseReplacement?.()).catch(() => undefined);
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
