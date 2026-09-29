import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("OpenAI browser login works through the real SDK, IPC and desktop UI", async ({}, testInfo) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mauxi-openai-desktop-"));
  const project = path.join(temp, "project");
  await mkdir(project);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "login-test", scripts: { dev: "vite" }, devDependencies: { vite: "7.3.6" }, dependencies: { react: "19.3.0" } }));
  await writeFile(path.join(project, "vite.config.ts"), 'import { defineConfig } from "vite"; export default defineConfig({ plugins: [] });');
  await writeFile(path.join(project, "index.html"), '<html><body><h1>Login test workspace</h1></body></html>');
  await symlink(path.resolve("node_modules"), path.join(project, "node_modules"), "dir");
  const app = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_PROOF: "0", MAUXI_RENDERER_URL: "", MAUXI_STATE_DIR: path.join(temp, "recovery"), XDG_CONFIG_HOME: path.join(temp, "config") },
  });
  try {
    // Keep all host/SDK/UI code real. Replace only the OS browser launcher and
    // remote token exchange, so the test never signs into a live account.
    await app.evaluate(({ shell }) => {
      const state = { urls: [] as string[], failBrowser: false, tokenRequests: 0 };
      (globalThis as any).loginTest = state;
      Object.assign(shell, { openExternal: async (url: string) => {
        state.urls.push(url);
        if (state.failBrowser) throw new Error("No default browser");
      } });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (String(url) === "https://auth.openai.com/oauth/token") {
          state.tokenRequests++;
          const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64")}.signature`;
          return new Response(JSON.stringify({ access_token: access, refresh_token: "fake-refresh", expires_in: 3600 }), { status: 200 });
        }
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(String(url))) return originalFetch(url, init);
        throw new Error("External network disabled in login test");
      };
    });
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), project);
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" as const });
    page = await next;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    const loginButton = page.getByRole("button", { name: "OpenAI (ChatGPT Plus/Pro)", exact: true });
    await loginButton.click();
    await page.getByRole("button", { name: "Browser login (default)", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const manual = page.getByRole("textbox", { name: "Complete login in your browser, or paste the authorization code / redirect URL here:", exact: true });
    await expect(manual).toBeVisible();
    await expect(page.getByRole("button", { name: "Open sign-in", exact: true })).toBeVisible();
    await expect.poll(() => app.evaluate(() => (globalThis as any).loginTest.urls.length)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("openai-browser-login.png") });

    // Complete the same localhost callback a real browser would use.
    await app.evaluate(async () => {
      const auth = new URL((globalThis as any).loginTest.urls[0]);
      const callback = new URL("http://127.0.0.1:1455/auth/callback");
      callback.searchParams.set("code", "fake-code");
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      const response = await fetch(callback);
      if (!response.ok) throw new Error("Callback failed");
      await response.text();
    });
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    const provider = page.locator(".provider-list article").filter({ has: page.getByText("OpenAI Codex", { exact: true }) });
    await expect(provider).toContainText("Connected");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).loginTest.tokenRequests)).toBe(1);

    // OS launch failures must be caught, retain the link/input, and allow cancel.
    await app.evaluate(() => { (globalThis as any).loginTest.failBrowser = true; });
    await provider.getByRole("button", { name: "Re-authenticate", exact: true }).click();
    await page.getByRole("button", { name: "Browser login (default)", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(manual).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Could not open your default browser");
    await page.getByRole("button", { name: "Open sign-in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Check your system browser settings");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    await expect(provider.getByRole("button", { name: "Re-authenticate", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
