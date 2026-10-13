import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

for (const width of [1500, 390]) {
  test(`onboarding-style model select searches, navigates and hides providers at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    await mockDesktop(page);
    await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      const model = (provider: string, id: string, name: string, supportsImages = true, available = true) => ({ key: `${provider}/${id}`, provider, id, name, available, supportsImages, thinkingLevels: ["off", "low"] });
      state.modelsSnapshot = {
        ready: true, workspaceId: "test-workspace",
        providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true, authMethods: [] }, { id: "anthropic", name: "Anthropic", authenticated: true, authMethods: [] }, ...Array.from({ length: 14 }, (_, index) => ({ id: `other-${index}`, name: `Other provider ${index}`, authenticated: false, authMethods: [] }))],
        models: [model("openai-codex", "gpt-6-sol", "GPT-6 Sol"), model("openai-codex", "gpt-6-luna", "GPT-6 Luna"), model("openai-codex", "gpt-6-astra", "GPT-6 Astra"), model("openai-codex", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", false), model("anthropic", "claude-opus-5-5", "Claude Opus 5.5"), model("unconfigured", "hidden", "Unavailable model", false, false)],
        selectedModel: "openai-codex/gpt-6-sol", messages: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
      };
      const emit = () => state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot: state.modelsSnapshot }));
      window.mauxi!.agentSelectModel = async ({ modelKey }) => { state.modelsSnapshot.selectedModel = modelKey; emit(); };
      window.mauxi!.agentSetThinking = async ({ level }) => { state.modelsSnapshot.thinkingLevel = level; emit(); };
      emit();
    });
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    const settings = page.getByRole("region", { name: "Models and providers", exact: true });
    const trigger = settings.getByRole("combobox", { name: /Model/ });
    const providers = settings.locator(".provider-list");
    const details = settings.locator(".model-details");
    await expect(settings.locator(".script-select-caption")).toHaveCount(0);
    const thinking = settings.getByRole("group", { name: "Thinking level" });
    for (const level of ["off", "low"]) {
      await expect(thinking.getByRole("button", { name: level, exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await thinking.getByRole("button", { name: "low", exact: true }).click();
    await expect(thinking.getByRole("button", { name: "low", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(thinking.getByRole("button", { name: "low", exact: true })).toHaveCSS("box-shadow", "none");
    await page.screenshot({ path: testInfo.outputPath("model-settings.png") });
    const chat = page.locator(".chat-dock");
    const closedHeight = await chat.evaluate(node => node.getBoundingClientRect().height);
    await expect(trigger).toContainText("OpenAI Codex · GPT-6 Sol");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(providers).toBeVisible();
    const providerEntries = providers.getByRole("region", { name: "Provider list" });
    const providerRows = providerEntries.locator("article");
    const providerHeight = width > 600 ? 216 : 324;
    expect(await providerEntries.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(providerHeight);
    expect(await providerEntries.evaluate(node => node.scrollHeight)).toBeGreaterThan(providerHeight);
    const providerThumb = providers.locator(".provider-scrollbar-thumb");
    expect((await providerThumb.boundingBox())!.height).toBeGreaterThanOrEqual(96);
    await expect(providerThumb).toHaveCSS("background-color", "rgb(196, 192, 187)");
    const fourthBottom = await providerRows.nth(3).evaluate(node => node.getBoundingClientRect().bottom);
    const fifthTop = await providerRows.nth(4).evaluate(node => node.getBoundingClientRect().top);
    const visibleBottom = await providerEntries.evaluate(node => node.getBoundingClientRect().bottom);
    expect(fourthBottom).toBeLessThanOrEqual(visibleBottom + 1);
    expect(fifthTop).toBeGreaterThanOrEqual(visibleBottom - 1);
    await providerEntries.evaluate(node => { node.scrollTop = node.clientHeight; });
    expect(await providerEntries.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect((await providerThumb.boundingBox())!.y).toBeGreaterThan((await providerEntries.boundingBox())!.y);
    await providers.locator(".provider-scrollbar").click({ position: { x: 4, y: providerHeight - 4 } });
    expect(await providerEntries.evaluate(node => node.scrollTop)).toBeGreaterThan(providerHeight);
    await providerEntries.evaluate(node => { node.scrollTop = 0; });
    const thumbAtTop = (await providerThumb.boundingBox())!;
    await page.mouse.move(thumbAtTop.x + thumbAtTop.width / 2, thumbAtTop.y + 10);
    await page.mouse.down();
    await page.mouse.move(thumbAtTop.x + thumbAtTop.width / 2, thumbAtTop.y + 50);
    await page.mouse.up();
    expect(await providerEntries.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await trigger.hover();
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.down();
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(trigger).toHaveCSS("box-shadow", "none");
    await page.mouse.up();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(details).toHaveAttribute("aria-hidden", "true");
    await expect(details).toHaveAttribute("inert", "");
    await expect(details).toHaveCSS("opacity", "0");
    await expect(details).toHaveCSS("transition-duration", "0.09s");
    await expect(details).toHaveCSS("transition-delay", "0s, 0s");
    await expect(details).toHaveCSS("position", "absolute");
    await expect(settings.getByRole("group", { name: "Thinking level" })).toHaveCount(0);
    const models = settings.getByRole("listbox", { name: "Model" });
    await expect(models.getByRole("option")).toHaveCount(5);
    await expect(models.getByText("OpenAI Codex", { exact: true })).toBeVisible();
    await expect(models.getByText("Anthropic", { exact: true })).toBeVisible();
    const selected = models.getByRole("option", { name: /GPT-6 Sol/ });
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected.locator(".lucide-check")).toHaveCount(1);
    expect(await models.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.waitForFunction(() => !document.querySelector(".chat-dock")!.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations !== Infinity && animation.playState === "running"));
    const openHeight = await chat.evaluate(node => node.getBoundingClientRect().height);
    expect(openHeight).toBeLessThan(closedHeight);
    const menuGap = await settings.evaluate(node => node.getBoundingClientRect().bottom - node.querySelector(".script-select-popup")!.getBoundingClientRect().bottom);
    expect(menuGap).toBeLessThanOrEqual(14);
    expect(await settings.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("model-select.png") });

    // A partially visible row must not scroll itself fully into view on hover.
    // Only keyboard navigation should auto-scroll the options list.
    await models.evaluate(node => { node.scrollTop = 45; });
    const firstOption = models.getByRole("option").first();
    const optionBounds = (await firstOption.boundingBox())!;
    const listBounds = (await models.boundingBox())!;
    const scrollBeforeHover = await models.evaluate(node => node.scrollTop);
    expect(scrollBeforeHover).toBeGreaterThan(0);
    await page.mouse.move(optionBounds.x + optionBounds.width / 2, Math.max(optionBounds.y + 2, listBounds.y + 2));
    await expect(firstOption).toHaveAttribute("data-active", "true");
    expect(await models.evaluate(node => node.scrollTop)).toBeCloseTo(scrollBeforeHover, 0);

    const search = page.getByRole("searchbox", { name: "Search models" });
    await search.fill("gpt-6");
    await expect(models.getByRole("option")).toHaveCount(3);
    await expect(models.getByText("Anthropic", { exact: true })).toHaveCount(0);
    await search.fill("Anthropic");
    await expect(models.getByRole("option")).toHaveCount(1);
    expect(await chat.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(openHeight - 100);
    await search.fill("no such model");
    await expect(models.getByRole("status")).toHaveText("No models match “no such model”.");
    await search.fill("spark");
    await expect(models.getByRole("option")).toContainText("Text only");
    await search.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(details).not.toHaveAttribute("aria-hidden", "true");
    await expect(details).toHaveCSS("opacity", "1");
    await expect(details).toHaveCSS("transition-duration", "0s");
    expect(await chat.evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(closedHeight, 1);

    await trigger.press("ArrowDown");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await search.fill("gpt-6");
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(trigger).toHaveAttribute("aria-activedescendant", /option-1$/);
    await trigger.press("Enter");
    const picker = page.getByRole("button", { name: "Models & providers", exact: true });
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(picker).toContainText("GPT-6 Luna");
    await expect(settings).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await picker.click();
    await expect(trigger).toContainText("GPT-6 Luna");
    await expect(details).not.toHaveAttribute("inert", "");

    // Pointer re-entry uses setup's 160ms fade, with no delayed row cascade.
    await trigger.click();
    await expect(details).toHaveCSS("opacity", "0");
    await trigger.click();
    await expect(details).toHaveCSS("transition-duration", "0.16s, 0.16s");
    await expect(details).toHaveCSS("opacity", "1");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(details).toHaveCSS("transform", "none");
    await expect(settings.locator(".script-select-popup")).toHaveCSS("animation-name", "none");
    await trigger.click();
    await expect(details).toHaveCSS("opacity", "1");

    // Pointer selection uses the same full-panel close path, including animation.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await trigger.click();
    await models.getByRole("option", { name: /Claude Opus/ }).click();
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(picker).toContainText("Claude Opus 5.5");
    await expect(settings).toHaveCount(0);
    await expect(picker).toBeFocused();

    // Failed selections keep the panel available to retry and surface the error.
    await picker.click();
    await page.evaluate(() => { window.mauxi!.agentSelectModel = async () => { throw new Error("Model selection failed"); }; });
    await trigger.click();
    await models.getByRole("option", { name: /GPT-6 Sol/ }).click();
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    await expect(settings).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Model selection failed");
    await expect(trigger).toContainText("Claude Opus 5.5");
  });
}
