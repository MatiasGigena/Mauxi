import { closeProject } from "../helpers/workspace-controls";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ListeningAddressSchema = Type.Object({ port: Type.Number() });

test("only the two approved previews may override embedding headers", async ({}, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-frame-headers-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-frame-profile-"));
  const foreign = createServer((_request, response) => response.end("FOREIGN DOCUMENT"));
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve));
  const foreignOrigin = `http://127.0.0.1:${Value.Parse(ListeningAddressSchema, foreign.address()).port}`;
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const { port } = Value.Parse(ListeningAddressSchema, reserve.address());
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const csp = "object-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

  const config = `export default { plugins: [{ name: 'blocking-headers', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', ${JSON.stringify(csp)});
      res.setHeader('Content-Security-Policy-Report-Only', "object-src 'none'; frame-ancestors 'none'");
      if (req.url.startsWith('/redirect-local')) { res.writeHead(302, { Location: '/after-redirect' }); res.end(); return; }
      if (req.url.startsWith('/redirect-foreign')) { res.writeHead(302, { Location: ${JSON.stringify(foreignOrigin)} }); res.end(); return; }
      if (req.url.startsWith('/nested')) { res.setHeader('Content-Type', 'text/html'); res.end('<h1>NESTED DOCUMENT</h1>'); return; }
      next();
    });
  }}] };`;

  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "header-fixture", private: true, type: "module", scripts: { dev: `vite --host 127.0.0.1 --port ${port} --strictPort` }, dependencies: { vite: "7.3.6", react: "19.3.0" } }));
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "vite.config.mjs"), config);
  await writeFile(path.join(root, "index.html"), '<html><body><h1 data-testid="loaded">APP LOADED</h1></body></html>');

  const app = await electron.launch({ chromiumSandbox: true,
    ...(process.env.MAUXI_APPIMAGE ? { executablePath: process.env.MAUXI_APPIMAGE, args: [] } : { args: [path.resolve("dist-electron/main.js")] }),
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "profile") } });

  let stderr = ""; app.process().stderr?.on("data", chunk => { stderr += String(chunk); });

  try {
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), root);
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
    const active = (await page.evaluate(() => window.mauxi!.getBootstrap())).active!;
    const desktop = page.frames().find(frame => frame.url().includes("mauxiPreview=desktop"))!;
    const mobile = page.frames().find(frame => frame.url().includes("mauxiPreview=mobile"))!;
    await expect(desktop.getByTestId("loaded")).toBeVisible();
    await expect(mobile.getByTestId("loaded")).toBeVisible();

    expect((await fetch(origin)).headers.get("content-security-policy")).toBe(csp);
    expect(await desktop.evaluate(async () => (await fetch('/')).headers.get('x-frame-options'))).toBe("DENY");
    expect(await desktop.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'))).toBe(csp);
    expect(await desktop.evaluate(() => {
      const script = document.createElement('script'); script.textContent = 'window.inlineCodeRan = true'; document.body.append(script);

      return "inlineCodeRan" in window && window.inlineCodeRan === true;
    })).toBe(false);
    expect(await desktop.evaluate(async url => { try { await fetch(url, { mode: 'no-cors' });

    return true; } catch { return false; } }, foreignOrigin)).toBe(false);
    expect(await desktop.evaluate(() => typeof window.mauxi === "undefined")).toBe(true);

    await desktop.evaluate(() => { location.href = '/redirect-local'; });
    await expect.poll(() => new URL(desktop.url()).pathname).toBe("/after-redirect");
    await expect(desktop.getByTestId("loaded")).toBeVisible();
    await Promise.all([desktop.waitForNavigation({ waitUntil: 'domcontentloaded' }), desktop.evaluate(() => location.reload())]);
    await expect(desktop.getByTestId("loaded")).toBeVisible();

    const denied = page.waitForEvent("console", { predicate: message => message.text().includes('frame-ancestors') && message.text().includes('violates') });
    await desktop.evaluate(({ origin, workspaceId }) => {
      const nested = document.createElement('iframe'); nested.name = `mauxi-preview:${workspaceId}:desktop`; nested.src = origin + '/nested'; document.body.append(nested);
    }, { origin, workspaceId: active.workspaceId });
    await denied;
    expect(page.frames().some(frame => frame.url() === origin + '/nested')).toBe(false);

    const thirdDenied = page.waitForEvent("console", { predicate: message => message.text().includes('frame-ancestors') && message.text().includes('violates') });
    await page.evaluate(origin => { const frame = document.createElement('iframe'); frame.src = origin + '/nested?third'; document.body.append(frame); }, origin);
    await thirdDenied;
    expect(page.frames().some(frame => frame.url().includes('/nested?third'))).toBe(false);

    expect(app.process().spawnargs).not.toContain('--no-sandbox');
    expect(await desktop.evaluate(() => [typeof require === "undefined", typeof process === "undefined"])).toEqual([true, true]);
    expect(await desktop.evaluate(() => { try { return !!parent.document; } catch { return false; } })).toBe(false);
    const redirect = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/redirect-foreign') || request.url() === foreignOrigin + '/', timeout: 10_000 });
    await mobile.evaluate(() => { location.href = '/redirect-foreign'; });
    await redirect;
    expect(page.frames().some(frame => frame.url().startsWith(foreignOrigin))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("preview-headers.png") });
    const welcome = app.waitForEvent("window");
    await closeProject(page);
    page = await welcome;
    await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
    expect(await readFile(path.join(root, "vite.config.mjs"), "utf8")).toBe(config);
  } finally {
    await writeFile(testInfo.outputPath("electron-stderr.log"), stderr);
    await app.close();
    await new Promise<void>(resolve => foreign.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
