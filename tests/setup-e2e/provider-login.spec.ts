import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./fixtures";

async function openProviders(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep my draft");
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.responses = [];
    state.emit = (event: unknown) => state.agentListeners.forEach((listener: (event: unknown) => void) => listener(event));
    state.snapshot = {
      ready: true, workspaceId: "test-workspace",
      providers: Array.from({ length: 20 }, (_, i) => ({ id: `provider-${i}`, name: `Provider ${i}`, authenticated: false, authMethods: [{ type: "api_key", label: `Provider ${i} API key` }] })),
      models: [], messages: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    state.emit({ type: "snapshot", snapshot: state.snapshot });
    window.mauxi!.agentLogin = async ({ providerId }) => {
      state.emit({ type: "dialog", dialog: { id: "login-key", kind: "secret", title: providerId, message: "Enter your API key" } });
      await new Promise<void>(resolve => { state.finishLogin = resolve; });
    };
    window.mauxi!.agentDialogResponse = async response => {
      state.responses.push(response);
      if (state.rejectResponse) throw new Error("Could not save credentials");
      if (state.nextStep) {
        state.emit({ type: "dialog", dialog: { id: "manual-code", kind: "manual_code", title: "Complete sign-in", message: "Enter the verification code" } });
        state.nextStep = false;
        return;
      }
      state.emit({ type: "dialog-dismissed", id: response.dialogId });
      if (!response.cancelled) {
        state.snapshot.models = [{ key: "connected/model", provider: "Connected", id: "model", name: "Connected model", available: true, supportsImages: true, thinkingLevels: ["off"] }];
        state.emit({ type: "snapshot", snapshot: state.snapshot });
      }
      state.finishLogin();
    };
  });
  await page.getByRole("button", { name: "Models & providers", exact: true }).click();
  const settings = page.locator(".chat-settings");
  await expect(settings).toBeVisible();
  await settings.evaluate(node => { (window as any).setupTest.settingsNode = node; });
  const provider = page.getByRole("button", { name: "Provider 18 API key", exact: true });
  await provider.scrollIntoViewIfNeeded();
  return { settings, provider };
}

test("provider choice subtitles are hidden regardless of SDK wording", async ({ page }) => {
  const { settings, provider } = await openProviders(page);
  for (const [title, message] of [
    ["Amazon Bedrock", "Select Amazon Bedrock authentication method:"],
    ["Radius", "Sign in to Radius:"],
    ["Another provider", "Choose how you want to authenticate"],
  ]) {
    await provider.click();
    await expect(page.getByText("Enter your API key", { exact: true })).toBeVisible();
    await page.evaluate(({ title, message }) => {
      (window as any).setupTest.emit({ type: "dialog", dialog: {
        id: "auth-method", kind: "select", title, message, options: [
          { id: "token", label: "Bearer token" }, { id: "profile", label: "AWS profile" }, { id: "chain", label: "Existing AWS credential chain" },
        ],
      } });
    }, { title, message });
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog.getByText(message, { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: message, exact: true })).toBeVisible();
    await expect(dialog.locator(".login-option")).toHaveCount(3);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    await expect(settings).toBeVisible();
  }
});

for (const mode of ["pointer", "keyboard", "reduced"] as const) {
  test(`login replaces providers and chat actions, Cancel restores scroll: ${mode}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
    const { settings, provider } = await openProviders(page);
    const scroll = await settings.evaluate(node => node.scrollTop);
    const dockHeight = (await page.locator(".chat-dock").boundingBox())!.height;
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      state.motion = [];
      const animate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function (frames, options) {
        if (this.dataset.composerMotion) state.motion.push({ key: this.dataset.composerMotion, frames, options });
        return animate.call(this, frames, options);
      };
    });
    if (mode === "keyboard") { await provider.focus(); await provider.press("Enter"); }
    else await provider.click();
    const dialog = page.getByRole("dialog", { name: "provider-18" });
    await expect(dialog).toBeVisible();
    await expect(settings).toBeHidden();
    await expect(page.locator(".composer-toolbar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Models & providers", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Send|Checking…)$/ })).toHaveCount(0);
    await expect(page.locator("#chat-message")).toBeHidden();
    await expect(dialog).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(dialog).toHaveCSS("border-top-width", "0px");
    expect((await page.locator(".chat-dock").boundingBox())!.height).toBeLessThan(dockHeight);
    const input = dialog.getByLabel("Enter your API key");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("type", "password");
    await expect(dialog.locator(".lucide-arrow-right")).toHaveCount(0);
    const proceed = dialog.getByRole("button", { name: "Continue", exact: true });
    await expect(proceed).toBeDisabled();
    const motion = await page.evaluate(() => (window as any).setupTest.motion);
    if (mode === "pointer") {
      expect(motion).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "panel", options: expect.objectContaining({ duration: 110 }) }),
        expect.objectContaining({ key: "toolbar", options: expect.objectContaining({ duration: 110 }) }),
        expect.objectContaining({ key: "login", options: expect.objectContaining({ duration: 160 }) }),
      ]));
    } else expect(motion).toEqual([]);
    await input.fill("not-a-real-key");
    await expect(proceed).toBeEnabled();
    await expect(proceed).toHaveCSS("background-color", "rgb(24, 27, 34)");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await cancel.hover();
    await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath("provider-login.png") });
    if (mode === "keyboard") await input.press("Escape");
    else await cancel.click();
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(provider).toBeFocused();
    expect(await settings.evaluate(node => node.scrollTop)).toBe(scroll);
    expect(await settings.evaluate(node => node === (window as any).setupTest.settingsNode)).toBe(true);
    await expect(page.locator(".composer-toolbar")).toBeVisible();
    if (mode === "pointer") {
      expect(await page.evaluate(() => (window as any).setupTest.motion)).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "login", options: expect.objectContaining({ duration: 110 }) }),
        expect.objectContaining({ key: "panel", options: expect.objectContaining({ duration: 160 }) }),
        expect.objectContaining({ key: "toolbar", options: expect.objectContaining({ duration: 160 }) }),
      ]));
    }
    expect(await page.evaluate(() => (window as any).setupTest.responses)).toEqual([
      { workspaceId: "test-workspace", dialogId: "login-key", cancelled: true, value: undefined },
    ]);
    await page.getByRole("button", { name: "Close models and providers" }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep my draft");
  });
}

test("login handles response errors, step handoff, and successful return without losing the next dialog", async ({ page }) => {
  const { settings, provider } = await openProviders(page);
  await provider.click();
  const input = page.getByLabel("Enter your API key");
  await input.fill("not-a-real-key");
  await page.evaluate(() => { (window as any).setupTest.rejectResponse = true; });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not save credentials");
  await expect(input).toHaveValue("not-a-real-key");
  await expect(settings).toBeHidden();
  await page.evaluate(() => { const state = (window as any).setupTest; state.rejectResponse = false; state.nextStep = true; });
  await input.press("Enter");
  const code = page.getByLabel("Enter the verification code");
  await expect(code).toBeFocused();
  await expect(input).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Models & providers", exact: true })).toHaveCount(0);
  await code.fill("123456");
  await code.press("Enter");
  await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(provider).toBeFocused();
  await settings.getByRole("combobox", { name: /Model/ }).click();
  await expect(settings.getByRole("option", { name: /Connected model/ })).toHaveCount(1);
});

test("OAuth progress uses the replacement view on a narrow screen and survives a rapid reopen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const { settings, provider } = await openProviders(page);
  await provider.click();
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    window.mauxi!.openAuthUrl = async url => { state.openedUrl = url; };
    state.emit({ type: "dialog", dialog: {
      id: "browser-sign-in", kind: "progress", title: "Sign in with your browser", message: "Complete sign-in, then return here.", cancellable: true,
      links: [{ url: "https://example.com/login", label: "Open sign-in page" }],
    } });
  });
  const dialog = page.getByRole("dialog", { name: "Sign in with your browser" });
  await expect(dialog).toBeVisible();
  await expect(settings).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-toolbar")).toBeHidden();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Open sign-in page" }).click();
  expect(await page.evaluate(() => (window as any).setupTest.openedUrl)).toBe("https://example.com/login");
  const interrupted = await page.evaluate(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".provider-list button")].find(node => node.textContent === "Provider 18 API key")!;
    await new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (!button.disabled && !button.closest("[inert]")) { observer.disconnect(); resolve(); }
      });
      observer.observe(document.querySelector(".chat-dock")!, { subtree: true, attributes: true, attributeFilter: ["disabled", "inert"] });
      const cancel = document.querySelector<HTMLButtonElement>(".agent-dialog-inline .change-project")!;
      cancel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      cancel.click();
    });
    const exiting = !!document.querySelector(".composer-login")?.getAnimations().length;
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    button.click();
    return exiting;
  });
  expect(interrupted).toBe(true);
  const input = page.getByLabel("Enter your API key");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(settings).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(provider).toBeFocused();
});
