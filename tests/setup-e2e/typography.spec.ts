import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDesktop } from "./fixtures";

async function typography(locator: Locator) {
  return locator.evaluate(node => {
    const style = getComputedStyle(node);
    return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize, lineHeight: style.lineHeight };
  });
}

async function renderedFonts(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts.map(font => ({ family: font.familyName, custom: font.isCustomFont }));
  } finally { await cdp.detach(); }
}

test("model and provider labels use onboarding's rendered Poppins and medium weight", async ({ page }, testInfo) => {
  await mockDesktop(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  const onboarding = await typography(page.locator(".guided-rows strong").first());
  const onboardingFonts = await renderedFonts(page, ".guided-rows strong");
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await page.evaluate(() => {
    const snapshot = {
      ready: true, workspaceId: "test-workspace", providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true, authMethods: [] }],
      models: [{ key: "openai-codex/gpt-6-sol", provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", available: true, supportsImages: true, thinkingLevels: ["low"] }],
      messages: [], thinkingLevel: "low", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    (window as any).setupTest.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot }));
  });
  await page.getByRole("button", { name: "Models & providers", exact: true }).click();
  await page.getByRole("combobox", { name: /Model/ }).click();
  await page.evaluate(async () => { await document.fonts.ready; });
  const model = await typography(page.locator(".model-option strong"));
  const provider = await typography(page.locator(".provider-list article strong"));
  const modelFonts = await renderedFonts(page, ".model-option strong");
  await testInfo.attach("font-comparison.json", { body: JSON.stringify({ onboarding, model, provider, onboardingFonts, modelFonts }, null, 2), contentType: "application/json" });
  expect(onboardingFonts).toEqual([{ family: "Poppins Medium", custom: true }]);
  expect(modelFonts).toEqual(onboardingFonts);
  expect(model).toEqual(onboarding);
  expect(provider).toEqual(onboarding);
});
