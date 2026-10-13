import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./fixtures";

async function start(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".chat-dock")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot = {
      ready: true, workspaceId: "test-workspace", sessionId: "session", providers: [],
      models: [{ key: "fake/one", name: "Fake", provider: "fake", id: "one", available: true, supportsImages: true, thinkingLevels: ["off"] }],
      selectedModel: "fake/one", messages: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    state.emit = () => state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot: { ...state.agentSnapshot } }));
    state.sent = [];
    state.stops = 0;
    state.sendMode = "accept";
    window.mauxi!.agentSend = async request => {
      state.sent.push(request);
      if (state.sendMode === "delayed") await new Promise<void>(resolve => { state.releaseSend = resolve; });
      if (state.sendMode === "reject") return { accepted: false };
      if (state.sendMode === "throw") throw new Error("Send failed");
      state.agentSnapshot.messages = [...state.agentSnapshot.messages, { id: String(state.sent.length), role: "user", text: request.text }];
      state.agentSnapshot.runState = "working";
      state.emit();
      return { accepted: true };
    };
    window.mauxi!.agentStop = async () => {
      state.stops++;
      await new Promise<void>(resolve => { state.releaseStop = resolve; });
      if (state.stopError) throw new Error("Could not stop");
      state.agentSnapshot.runState = "idle";
      state.emit();
    };
    state.emit();
  });
}

async function settled(page: Page) {
  await page.locator(".send-action").evaluate(async node => {
    await Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
}

test("Enter sends prompts and follow-ups; Shift+Enter inserts line breaks", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  const action = page.locator(".send-action");
  await editor.fill("First line");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("Second line");
  await expect(editor).toHaveValue("First line\nSecond line");
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(0);
  await editor.press("Enter");
  await expect(editor).toHaveValue("");
  await expect(action).toHaveAccessibleName("Stop");
  await editor.press("Enter");
  expect(await page.evaluate(() => (window as any).setupTest.stops)).toBe(0);
  await editor.fill("Follow-up line");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("More details");
  await expect(action).toHaveAccessibleName("Follow up");
  await editor.press("Enter");
  await expect(editor).toHaveValue("");
  expect(await page.evaluate(() => (window as any).setupTest.sent.map((request: any) => ({ text: request.text, behavior: request.behavior })))).toEqual([
    { text: "First line\nSecond line", behavior: "prompt" },
    { text: "Follow-up line\nMore details", behavior: "followUp" },
  ]);
});

test("Enter does not send while composing with an IME or without a selected model", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Composed text");
  for (const composing of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await editor.evaluate((node, composing) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...composing })), composing);
  }
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(0);
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot.selectedModel = undefined;
    state.emit();
  });
  await expect(page.locator(".send-action")).toBeDisabled();
  await editor.press("Enter");
  await expect(editor).toHaveValue("Composed text");
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(0);
});

test("sending switches directly to Stop and only new typing switches to Follow up", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  const action = page.locator(".send-action");
  await page.evaluate(() => { (window as any).setupTest.sendMode = "delayed"; });
  await editor.fill("Submitted draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(action).toHaveAccessibleName("Stop");
  await expect(action).toBeDisabled();
  await expect(action).not.toContainText("Checking");
  await expect.poll(() => page.evaluate(() => !!(window as any).setupTest.releaseSend)).toBe(true);
  await editor.press("Enter");
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(1);
  await editor.fill("Next draft\nKeep this line");
  await expect(action).toHaveAccessibleName("Follow up");
  await expect(action).toBeDisabled();
  await editor.press("Enter");
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(1);
  await page.evaluate(() => (window as any).setupTest.releaseSend());
  await expect(action).toBeEnabled();
  await expect(action).toHaveAccessibleName("Follow up");
  await expect(editor).toHaveValue("Next draft\nKeep this line");
  await page.evaluate(() => { (window as any).setupTest.sendMode = "accept"; });
  await editor.press("Enter");
  await expect(action).toHaveAccessibleName("Stop");
  expect(await page.evaluate(() => (window as any).setupTest.sent.map((request: any) => request.behavior))).toEqual(["prompt", "followUp"]);
});

for (const sendMode of ["reject", "throw"]) {
  test(`failed ${sendMode} sends restore Send and retain the draft`, async ({ page }) => {
    await start(page);
    await page.evaluate(sendMode => { (window as any).setupTest.sendMode = sendMode; }, sendMode);
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.fill("Keep this draft");
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toContainText(sendMode === "reject" ? "not accepted" : "Send failed");
    await expect(page.locator(".send-action")).toHaveAccessibleName("Send");
    await expect(page.locator(".send-action")).toBeEnabled();
    await expect(editor).toHaveValue("Keep this draft");
  });
}

test("one stable action sends, queues follow-ups, and stops without losing a new draft", async ({ page }) => {
  await start(page);
  const action = page.locator(".send-action");
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(action).toHaveCount(1);
  await expect(action).toHaveAccessibleName("Send");
  await expect(action).toBeDisabled();
  await action.evaluate(node => { (window as any).originalAction = node; });
  const width = (await action.boundingBox())!.width;
  expect(width).toBeLessThan(120);
  const right = (await action.boundingBox())!.x + width;
  await editor.fill("First prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(action).toHaveAccessibleName("Stop");
  await expect(action).toBeEnabled();
  await expect(action).toHaveAttribute("type", "button");
  await expect(page.locator(".stop-button, .composer-secondary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
  await editor.fill("Queued follow-up");
  await expect(action).toHaveAccessibleName("Follow up");
  await expect(action).toHaveAttribute("type", "submit");
  const followUp = (await action.boundingBox())!;
  expect(followUp.width).toBeGreaterThan(width + 15);
  expect(followUp.x + followUp.width).toBeCloseTo(right, 0);
  await page.getByRole("button", { name: "Follow up", exact: true }).click();
  await expect(action).toHaveAccessibleName("Stop");
  expect(await page.evaluate(() => (window as any).setupTest.sent.map((request: any) => request.behavior))).toEqual(["prompt", "followUp"]);
  await editor.fill("   ");
  await expect(action).toHaveAccessibleName("Stop");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(action).toHaveAccessibleName("Stopping…");
  await expect(action).toBeDisabled();
  await editor.fill("Draft typed while stopping\nKeep this line");
  await expect(action).toHaveAccessibleName("Stopping…");
  await action.evaluate(node => node.closest("form")!.requestSubmit());
  expect(await page.evaluate(() => (window as any).setupTest.stops)).toBe(1);
  expect(await page.evaluate(() => (window as any).setupTest.sent.length)).toBe(2);
  await page.evaluate(() => (window as any).setupTest.releaseStop());
  await expect(action).toHaveAccessibleName("Send");
  await expect(action).toBeEnabled();
  await expect(editor).toHaveValue("Draft typed while stopping\nKeep this line");
  expect((await action.boundingBox())!.width).toBe(width);
  expect(await action.evaluate(node => node === (window as any).originalAction)).toBe(true);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`Send/Stop transition is short, reversible and respects ${reducedMotion}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await start(page);
    const action = page.locator(".send-action");
    await page.evaluate(() => {
      (window as any).buttonSurfaceAnimations = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.classList.contains("send-action-surface")) (window as any).buttonSurfaceAnimations.push(args);
        return animate.apply(this, args);
      };
    });
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Start");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(action).toHaveAccessibleName("Stop");
    await settled(page);
    const surfaceAnimations = await page.evaluate(() => (window as any).buttonSurfaceAnimations);
    if (reducedMotion === "reduce") expect(surfaceAnimations).toHaveLength(0);
    else {
      expect(surfaceAnimations.length).toBeGreaterThan(0);
      expect(surfaceAnimations.every((args: any) => args[0][0].transform.startsWith("scaleX("))).toBe(true);
      expect(surfaceAnimations.every((args: any) => args[1].duration <= 180)).toBe(true);
    }
    const stopLayer = action.locator(".send-action-state").filter({ hasText: /^Stop$/ });
    await expect(stopLayer).toHaveCSS("opacity", "1");
    await expect(stopLayer).toHaveCSS("transform", "none");
    expect(await stopLayer.evaluate(node => getComputedStyle(node).transitionDuration)).toBe(reducedMotion === "reduce" ? "0s" : "0.16s");
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      state.agentSnapshot.runState = "idle"; state.emit();
    });
    await expect(action).toHaveAccessibleName("Send");
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      state.agentSnapshot.runState = "working"; state.emit();
    });
    await expect(action).toHaveAccessibleName("Stop");
    await settled(page);
    await expect(stopLayer).toHaveCSS("opacity", "1");
    await expect(action.locator('[data-active=false]').first()).toHaveCSS("opacity", "0");
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.pressSequentially("a");
    await expect(action).toHaveAccessibleName("Follow up");
    await expect(action).toHaveAttribute("data-instant", "true");
    await expect(action.locator('[data-active=true]')).toHaveCSS("transition-duration", "0s");
    expect(await action.locator(".send-action-surface").evaluate(node => node.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
    await editor.press("Backspace");
    await expect(action).toHaveAccessibleName("Stop");
    await expect(action).toBeEnabled();
  });
}

test("keeps only the upper response error while preserving distinct alerts", async ({ page }) => {
  await start(page);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Reproduce error");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot.runState = "error";
    state.agentSnapshot.messages.push({ id: "error", role: "assistant", error: true, text: "Codex error: The usage limit has been reached" });
    state.agentSnapshot.error = { kind: "runtime", message: "Codex error: The usage limit has been reached" };
    state.emit();
  });
  await expect(page.getByText("Codex error: The usage limit has been reached", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("log")).toContainText("Codex error: The usage limit has been reached");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot.error = { kind: "runtime", message: "Checkpoint error: could not persist changes" };
    state.emit();
  });
  await expect(page.getByRole("alert")).toHaveText("Checkpoint error: could not persist changes");
  await expect(page.getByRole("log")).toContainText("Codex error: The usage limit has been reached");
});

test("stop errors restore the action and preserve the current exchange", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Keep my output");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.evaluate(() => { (window as any).setupTest.stopError = true; });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => (window as any).setupTest.releaseStop());
  await expect(page.getByRole("alert")).toContainText("Could not stop");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "User prompt" })).toContainText("Keep my output");
});
