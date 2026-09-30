import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

test("model setup expands inside chat and the send border keeps moving", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".chat-dock")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    const snapshot = {
      ready: true, workspaceId: "test-workspace", providers: [{ id: "fake", name: "Fake", authenticated: true, authMethods: [{ type: "api_key", label: "API key" }] }],
      models: [{ key: "fake/one", provider: "Fake", id: "one", name: "Model One", available: true, supportsImages: true, thinkingLevels: ["off", "low"] }],
      sessions: [], messages: [], tools: [], changeSets: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    state.agentSnapshot = snapshot;
    window.mauxi!.agentSelectModel = async ({ modelKey }) => {
      state.selectedModel = modelKey;
      state.agentSnapshot = { ...state.agentSnapshot, selectedModel: modelKey };
      state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot: state.agentSnapshot }));
    };
    state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot }));
  });

  const send = page.locator(".composer button[type=submit]");
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS("opacity", "0.48");
  await expect.poll(() => send.evaluate((button) => getComputedStyle(button.querySelector(".send-action-surface")!, "::before").animationPlayState)).toBe("running");
  const firstTransform = await send.evaluate((button) => getComputedStyle(button.querySelector(".send-action-surface")!, "::before").transform);
  await expect.poll(() => send.evaluate((button) => getComputedStyle(button.querySelector(".send-action-surface")!, "::before").transform)).not.toBe(firstTransform);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Keep this draft while choosing a model");
  const dock = page.locator(".chat-dock");
  const closedHeight = (await dock.boundingBox())!.height;
  await page.getByRole("button", { name: "Models & providers" }).click();
  await expect(page.locator(".chat-settings")).toBeVisible();
  await expect(page.getByText(/Provider credentials stay/)).toHaveCount(0);
  await expect(page.locator("#chat-message")).toBeHidden();
  await expect(page.locator(".composer-message")).toHaveAttribute("inert", "");
  await expect(message).toHaveCount(0);
  await expect(page.locator(".agent-settings-backdrop")).toHaveCount(0);
  await expect(page.locator(".chat-dock .chat-surface")).toHaveJSProperty("isConnected", true);
  await expect.poll(async () => (await dock.boundingBox())!.height).toBeGreaterThan(closedHeight);
  await page.screenshot({ path: testInfo.outputPath("chat-settings.png") });
  await page.getByRole("combobox", { name: /Model/ }).click();
  await page.getByRole("option", { name: /Model One/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).setupTest.selectedModel)).toBe("fake/one");
  await expect(page.getByRole("group", { name: "Thinking level" })).toBeVisible();
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "Close models and providers" }).click();
  await expect(page.locator(".chat-settings")).toHaveCount(0);
  await expect(message).toBeVisible();
  await expect(message).toHaveValue("Keep this draft while choosing a model");
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS("opacity", "1");
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    window.mauxi!.agentDialogResponse = async (response) => { state.dialogResponse = response; };
    state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "dialog", dialog: {
      id: "provider-choice", kind: "select", title: "Choose sign-in method", message: "Select one option", options: [{ id: "oauth", label: "Browser sign-in" }],
    } }));
  });
  await expect(page.locator(".agent-dialog-inline")).toBeVisible();
  await expect(page.getByText("Select one option", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-dialog-backdrop")).toHaveCount(0);
  const proceed = page.getByRole("button", { name: "Continue", exact: true });
  await expect(proceed).toBeDisabled();
  await expect(proceed).toHaveCSS("opacity", "0.48");
  await page.getByRole("button", { name: "Browser sign-in" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).setupTest.dialogResponse?.value)).toBe("oauth");
});
