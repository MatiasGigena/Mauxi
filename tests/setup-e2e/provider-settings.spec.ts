import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

for (const width of [1280, 390]) {
  test(`provider actions are background-free and Conversations is absent at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await mockDesktop(page);
    await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      state.actions = [];
      window.mauxi!.agentLogin = async (request) => {
        state.actions.push({ action: "login", ...request });
        await new Promise<void>(resolve => { state.finishLogin = resolve; });
      };
      window.mauxi!.agentLogout = async (request) => { state.actions.push({ action: "logout", ...request }); };
      window.mauxi!.agentRefreshCatalog = async () => { state.actions.push({ action: "refresh" }); };
      const snapshot = {
        ready: true, workspaceId: "test-workspace",
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, authMethods: [{ type: "oauth", label: "Anthropic (Claude Pro/Max)" }, { type: "api_key", label: "Anthropic API key" }] },
          { id: "connected", name: "Connected provider", authenticated: true, authMethods: [{ type: "api_key", label: "API key" }] },
        ],
        models: [], sessions: [{ id: "old-session", name: "Previous conversation", active: true, updatedAt: Date.now() }],
        messages: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
      };
      state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot }));
    });
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    const settings = page.getByRole("region", { name: "Models and providers" });
    await expect(settings).toBeVisible();
    await expect(settings.getByText("Conversations", { exact: true })).toHaveCount(0);
    await expect(settings.getByText("Previous conversation")).toHaveCount(0);
    await expect(settings.locator(".session-list, .rename-row, .primary")).toHaveCount(0);
    await expect(settings.locator(".settings-action")).toHaveCount(5);
    for (const action of await settings.locator(".settings-action").all()) {
      await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(action).toHaveCSS("box-shadow", "none");
    }
    const login = settings.getByRole("button", { name: "Anthropic (Claude Pro/Max)", exact: true });
    await login.hover();
    await expect(login).toHaveCSS("color", "rgb(20, 122, 122)");
    await expect(login).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect.poll(() => login.locator("span").evaluate(node => getComputedStyle(node, "::after").transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    const secondary = settings.getByRole("button", { name: "Anthropic API key", exact: true });
    await secondary.hover();
    await expect(secondary).toHaveCSS("color", "rgb(185, 78, 56)");
    await expect(secondary).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(secondary.locator("svg")).toHaveCSS("color", "rgb(185, 78, 56)");
    await secondary.focus();
    await expect(secondary).toHaveCSS("outline-color", "rgb(185, 78, 56)");
    await expect.poll(() => secondary.locator("span").evaluate(node => getComputedStyle(node, "::after").backgroundColor)).toBe("rgb(185, 78, 56)");
    await expect(settings.getByRole("button", { name: "Re-authenticate", exact: true })).toHaveCSS("--settings-accent", "#b94e38");
    await expect(settings.getByRole("button", { name: "Refresh catalog", exact: true })).toHaveCSS("--settings-accent", "#147a7a");
    await page.screenshot({ path: testInfo.outputPath("provider-text-actions.png") });
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await login.click();
    await expect(settings.locator(".settings-action:disabled")).toHaveCount(5);
    await page.evaluate(() => (window as any).setupTest.finishLogin());
    await expect(login).toBeEnabled();
    await settings.getByRole("button", { name: "Log out", exact: true }).click();
    const refresh = settings.getByRole("button", { name: "Refresh catalog", exact: true });
    await refresh.focus();
    await refresh.press("Enter");
    await expect(refresh).toBeFocused();
    await expect(refresh).toHaveCSS("outline-style", "solid");
    expect(await page.evaluate(() => (window as any).setupTest.actions)).toEqual([
      { action: "login", workspaceId: "test-workspace", providerId: "anthropic", type: "oauth" },
      { action: "logout", workspaceId: "test-workspace", providerId: "connected" },
      { action: "refresh" },
    ]);
  });
}
