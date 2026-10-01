import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./fixtures";

async function start(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".chat-dock")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot = {
      ready: true, workspaceId: "test-workspace", sessionId: "session",
      providers: [], models: [{ key: "fake/one", name: "Fake", provider: "fake", id: "one", available: true, supportsImages: true, thinkingLevels: ["off"] }],
      selectedModel: "fake/one", sessions: [], messages: [], tools: [], changeSets: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    state.emit = () => state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot: { ...state.agentSnapshot } }));
    state.emit();
    state.sendMode = "accept";
    window.mauxi!.agentSend = async request => {
      if (state.sendMode === "reject") return { accepted: false };
      if (state.sendMode === "throw") throw new Error("Send failed");
      if (state.sendMode === "delayed") await new Promise<void>(resolve => { state.releaseSend = resolve; });
      if (state.sendMode !== "queued") {
        state.agentSnapshot.messages = [...state.agentSnapshot.messages, { id: `user-${state.agentSnapshot.messages.length}`, role: "user", text: request.text }];
      }
      state.agentSnapshot.runState = "working";
      state.emit();
      return { accepted: true };
    };
  });
}

async function output(page: Page, text: string, pending = true) {
  await page.evaluate(({ text, pending }) => {
    const state = (window as any).setupTest;
    const snapshot = state.agentSnapshot;
    const messages = snapshot.messages.filter((message: any) => !message.id.startsWith("output-" + (snapshot.messages.filter((item: any) => item.role === "user").length)));
    snapshot.messages = [...messages, { id: `output-${messages.filter((item: any) => item.role === "user").length}`, role: "assistant", text, pending }];
    snapshot.runState = pending ? "working" : "idle";
    state.emit();
  }, { text, pending });
}

async function settled(page: Page) {
  await page.locator(".chat-dock").evaluate(async node => {
    await Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`draft grows and shrinks with expansion motion: ${reducedMotion}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion });
    await start(page);
    const dock = page.locator(".chat-dock");
    const canvasBefore = await page.getByTestId("canvas").boundingBox();
    const initial = (await dock.boundingBox())!;
    // Observe animations inside the page so fast growth motion can't finish
    // between a fill round-trip and an assertion.
    await page.evaluate(() => {
      (window as any).growthAnimations = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.classList.contains("chat-surface")) (window as any).growthAnimations.push(args);
        return animate.apply(this, args);
      };
      document.querySelector("#chat-message")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.fill("First line\nSecond line\nThird line\nFourth line");
    await settled(page);
    const expanded = (await dock.boundingBox())!;
    expect(expanded.height).toBeGreaterThan(initial.height + 40);
    expect(expanded.y + expanded.height).toBeCloseTo(initial.y + initial.height, 0);
    const animations = await page.evaluate(() => (window as any).growthAnimations);
    if (reducedMotion === "reduce") expect(animations).toHaveLength(0);
    else expect(animations[0][1]).toEqual({ duration: 200, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });
    await editor.fill("Short");
    await settled(page);
    expect((await dock.boundingBox())!.height).toBeCloseTo(initial.height, 0);
    await editor.fill("A long wrapping line ".repeat(100));
    await settled(page);
    expect((await editor.boundingBox())!.height).toBeLessThanOrEqual(160);
    expect((await dock.boundingBox())!.height).toBeLessThanOrEqual(440);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(editor).toBeVisible();
    await editor.fill("Short again");
    await settled(page);
    expect(await page.locator(".chat-surface").evaluate(node => node.getAnimations().length)).toBe(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.getByTestId("canvas").boundingBox()).toEqual(canvasBefore);
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }, { width: 1280, height: 600 }]) {
  test(`latest prompt and streaming output grow to cap at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await start(page);
    const canvas = await page.getByTestId("canvas").boundingBox();
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.fill("Make the hero simpler");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("region", { name: "User prompt" })).toHaveText("YouMake the hero simpler");
    await expect(editor).toHaveValue("");
    await settled(page);
    const workingExchange = (await page.locator(".chat-exchange").boundingBox())!;
    expect((await editor.boundingBox())!.y - (workingExchange.y + workingExchange.height)).toBeCloseTo(20, 0);
    await output(page, "I’m simplifying the hero.");
    await settled(page);
    const short = (await page.locator(".chat-dock").boundingBox())!;
    await output(page, Array.from({ length: 40 }, (_, i) => `Response line ${i + 1}`).join("\n"));
    await settled(page);
    const capped = (await page.locator(".chat-dock").boundingBox())!;
    expect(capped.height).toBeGreaterThan(short.height);
    expect(capped.height).toBeLessThanOrEqual(viewport.height * .55 + 1);
    expect(await page.locator(".chat-response-output").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    const prompt = (await page.locator(".chat-prompt").boundingBox())!;
    const response = (await page.locator(".chat-response").boundingBox())!;
    expect(prompt.y).toBeGreaterThanOrEqual(capped.y);
    expect(prompt.y + prompt.height).toBeLessThan(response.y);
    const exchange = (await page.locator(".chat-exchange").boundingBox())!;
    expect((await editor.boundingBox())!.y - (exchange.y + exchange.height)).toBeCloseTo(20, 0);
    await expect(editor).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    expect(await page.getByTestId("canvas").boundingBox()).toEqual(canvas);
    await page.screenshot({ path: testInfo.outputPath("latest-exchange-at-cap.png") });
    await output(page, "Completed first output", false);
    await editor.fill("Now change the footer");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("region", { name: "User prompt" })).toContainText("Now change the footer");
    await expect(page.getByText("Make the hero simpler", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Completed first output", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).setupTest.agentSnapshot.messages.some((message: any) => message.text === "Make the hero simpler"))).toBe(true);
    await output(page, "Footer updated", false);
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Footer updated");
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath("latest-exchange.png") });
  });
}

test("queued and rejected sends don't show a previous turn as the new response", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("First");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await output(page, "First output", false);
  await page.evaluate(() => { (window as any).setupTest.sendMode = "reject"; });
  await editor.fill("Rejected prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not accepted");
  await expect(editor).toHaveValue("Rejected prompt");
  await expect(page.getByRole("log")).toContainText("First output");
  await page.evaluate(() => { (window as any).setupTest.sendMode = "queued"; });
  await editor.fill("Queued prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "User prompt" })).toContainText("Queued prompt");
  await expect(page.getByRole("log")).toContainText("Queued for agent…");
  await output(page, "Old run keeps streaming");
  await expect(page.getByText("Old run keeps streaming", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot.messages.push({ id: "queued-user", role: "user", text: "Queued prompt" });
    state.emit();
  });
  await output(page, "Queued response", false);
  await expect(page.getByRole("log")).toContainText("Queued response");
});

test("sending preserves text typed while acceptance is pending", async ({ page }) => {
  await start(page);
  await page.evaluate(() => { (window as any).setupTest.sendMode = "delayed"; });
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Submitted draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).setupTest.releaseSend)).toBe(true);
  await editor.fill("Next draft\nKeep this line");
  await page.evaluate(() => (window as any).setupTest.releaseSend());
  await expect(page.getByRole("region", { name: "User prompt" })).toContainText("Submitted draft");
  await expect(editor).toHaveValue("Next draft\nKeep this line");
});

test("streaming follows output until the user scrolls up, and resumes at the bottom", async ({ page }) => {
  await start(page);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Show a long response");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n");
  const response = page.getByRole("log", { name: "Agent response" });
  await output(page, lines);
  await settled(page);
  await expect.poll(() => response.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
  await response.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  await output(page, lines + "\nMore text");
  await settled(page);
  expect(await response.evaluate(node => node.scrollTop)).toBe(0);
  await response.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
  await output(page, lines + "\nMore text\nLast line");
  await settled(page);
  await expect.poll(() => response.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
});

test("settings retain the latest exchange and compaction doesn't revive an accepted prompt", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Current turn");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await output(page, "Current output", false);
  await page.getByRole("button", { name: "Models & providers", exact: true }).click();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
  await expect(page.locator(".chat-exchange")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Close models and providers", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Current output");
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot.messages = [{ id: "compacted-user", role: "user", text: "Compacted latest prompt" }, { id: "compacted-output", role: "assistant", text: "Compacted output" }];
    state.emit();
  });
  await expect(page.getByRole("region", { name: "User prompt" })).toContainText("Compacted latest prompt");
  await expect(page.getByRole("log")).toContainText("Compacted output");
  await page.evaluate(() => {
    const state = (window as any).setupTest;
    state.agentSnapshot = { ...state.agentSnapshot, sessionId: "new-session", messages: [] };
    state.emit();
  });
  await expect(page.locator(".chat-exchange")).toHaveCount(0);
});

for (const { viewport, reducedMotion } of [
  { viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" },
  { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" },
  { viewport: { width: 390, height: 800 }, reducedMotion: "no-preference" },
] as const) {
  test(`canvas click minimizes and chat click restores with ${reducedMotion} at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion });
    await start(page);
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    const dock = page.locator(".chat-dock");
    const canvas = page.getByTestId("canvas");
    const initial = (await dock.boundingBox())!;
    const canvasBounds = await canvas.boundingBox();
    await editor.fill("Hi");
    await editor.press("Enter");
    await output(page, "Hi! What would you like help with?", false);
    await settled(page);
    await page.evaluate(() => {
      (window as any).minimizeAnimations = [];
      (window as any).exchangeNode = document.querySelector(".chat-exchange");
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.matches(".chat-surface, .chat-exchange")) (window as any).minimizeAnimations.push({ className: this.className, options: args[1] });
        return animate.apply(this, args);
      };
    });
    await canvas.click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole("region", { name: "Latest exchange" })).toHaveCount(0);
    await expect(page.locator(".chat-exchange")).toHaveAttribute("inert", "");
    await expect(editor).not.toBeFocused();
    await settled(page);
    const minimized = (await dock.boundingBox())!;
    expect(minimized.height).toBeCloseTo(initial.height, 0);
    expect(minimized.y + minimized.height).toBeCloseTo(initial.y + initial.height, 0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await editor.click();
    await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Hi! What would you like help with?");
    await settled(page);
    expect(await page.locator(".chat-exchange").evaluate(node => node === (window as any).exchangeNode)).toBe(true);
    expect(await canvas.boundingBox()).toEqual(canvasBounds);
    const animations = await page.evaluate(() => (window as any).minimizeAnimations);
    if (reducedMotion === "reduce") expect(animations).toEqual([]);
    else {
      expect(animations.filter((item: any) => item.className === "chat-surface").map((item: any) => item.options.duration)).toEqual([160, 200]);
      expect(animations.filter((item: any) => item.className === "chat-exchange").map((item: any) => item.options.duration)).toEqual([110, 160]);
    }
  });
}

test("minimized streaming preserves the draft, history and manual response scroll", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Show a long response");
  await editor.press("Enter");
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n");
  await output(page, lines);
  await settled(page);
  await page.getByRole("log", { name: "Agent response" }).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  await editor.fill("Next draft\nKeep this line");
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
  await output(page, lines + "\nStill working while minimized");
  await settled(page);
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
  await expect(editor).toHaveValue("Next draft\nKeep this line");
  await expect(page.getByRole("button", { name: "Follow up", exact: true })).toBeEnabled();
  await editor.focus();
  await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Still working while minimized");
  await settled(page);
  expect(await page.getByRole("log", { name: "Agent response" }).evaluate(node => node.scrollTop)).toBe(0);
  expect(await page.evaluate(() => (window as any).setupTest.agentSnapshot.messages.filter((message: any) => message.role === "user").length)).toBe(1);
  await editor.fill("");
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
});

test("clicking inside a preview minimizes, unrelated shell clicks do not", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Keep this conversation");
  await editor.press("Enter");
  await output(page, "Completed response", false);
  await settled(page);
  await page.getByRole("button", { name: "Routes linked", exact: true }).click();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Completed response");
  await editor.focus();
  await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
  await page.frameLocator('[data-testid="desktop-preview"]').getByText("Test preview", { exact: true }).click();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
  await editor.focus();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Completed response");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await settled(page);
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Completed response");
});

test("rapid minimize and reopen reverses retained motion without duplicate exchanges", async ({ page }) => {
  await start(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("Keep the same exchange");
  await editor.press("Enter");
  await output(page, "Retained response", false);
  await settled(page);
  await page.evaluate(async () => {
    const target = document.querySelector('[aria-label="Focus Desktop"]')!;
    const editor = document.querySelector<HTMLTextAreaElement>("#chat-message")!;
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    (window as any).exchangeNode = document.querySelector(".chat-exchange");
    for (let i = 0; i < 4; i++) {
      // A child control avoids the canvas drag's pointer-capture requirement.
      target.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
      await frame();
      editor.focus();
      await frame();
    }
  });
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Retained response");
  await settled(page);
  expect(await page.locator(".chat-exchange").evaluate(node => node === (window as any).exchangeNode)).toBe(true);
  await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveCount(0);
  await settled(page);
  expect(await page.locator(".chat-content").evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await editor.click();
  await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Retained response");
});
