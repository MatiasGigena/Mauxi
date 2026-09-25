import { expect, test } from "@playwright/test";
import { discovery, mockDesktop, selectScript } from "./fixtures";

const settle = async (page: import("@playwright/test").Page) => {
  await page.waitForFunction(() => !document.querySelector(".project-setup")!.getAnimations({ subtree: true }).some(animation => animation.effect!.getTiming().iterations !== Infinity && animation.playState === "running"));
};

test("approved setup uses actual plans, commands, integration files and native IPC callbacks", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockDesktop(page);
  await expect(page.locator(".proto-picker, input[type=file], dialog")).toHaveCount(0);
  await expect(page.locator(".guided-intro")).toContainText("rondo.");
  await expect(page.locator(".guided-integration small")).toContainText("1 file modified, 3 artifacts created");
  await expect(page.locator(".review-trigger .lucide-plug")).toHaveCount(1);
  await page.locator(".configure-trigger").click();
  await selectScript(page, "pnpm run start");
  await expect(page.locator(".configure-trigger")).toContainText("pnpm run start");
  await expect(page.locator(".technical-details")).toContainText("http://127.0.0.1:3000");
  await page.keyboard.press("Escape");
  await page.locator(".review-trigger").click();
  await expect(page.locator(".guided-file-trigger")).toHaveCount(1);
  await expect(page.locator(".guided-file-trigger")).toContainText("instrumentation-client.ts");
  await page.locator(".guided-file-trigger").click();
  await expect(page.locator(".guided-file-panel[aria-hidden=false]")).toContainText("+ import './.mauxi/bridge'");
  await page.keyboard.press("Escape");
  await expect(page.locator(".project-setup")).toHaveAttribute("data-view", "review");
  await page.keyboard.press("Escape");
  await page.locator(".configure-trigger").click();
  await selectScript(page, "npm run dev");
  await page.keyboard.press("Escape");
  await page.locator(".review-trigger").click();
  await page.locator(".guided-file-trigger").first().click();
  await expect(page.locator(".guided-diff .removed").first()).toHaveCSS("color", "rgb(180, 54, 54)");
  await expect(page.locator(".guided-diff .added").first()).toHaveCSS("color", "rgb(24, 115, 64)");
  await expect(page.locator(".guided-file-panel[aria-hidden=false] pre")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await settle(page);
  await expect(page.locator(".guided-file-trigger:visible")).toHaveCount(1);
  await page.locator(".guided-file-trigger").first().click();
  await settle(page);
  await page.locator(".guided-file-trigger[data-action=modify]").hover();
  await expect(page.locator(".guided-file-trigger[data-action=modify]")).toHaveCSS("color", "rgb(146, 112, 0)");
  await page.locator(".guided-file-trigger[data-action=create]").first().hover();
  await expect(page.locator(".guided-file-trigger[data-action=create]").first()).toHaveCSS("color", "rgb(20, 122, 122)");
  await page.locator(".review-trigger").click();

  await page.locator(".configure-trigger").click();
  await selectScript(page, "pnpm run start");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).setupTest.next = null; (window as any).setupTest.pending = true; });
  await page.locator(".change-project").click();
  await expect(page.locator(".change-project")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Preparing…", exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).setupTest.release(); });
  await expect(page.locator(".change-project")).toBeEnabled();
  await expect(page.locator(".configure-trigger")).toContainText("pnpm run start");
  await expect(page.locator(".project-path")).toHaveText("/projects/rondo/storefront");
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  expect(await page.evaluate(() => (window as any).setupTest.confirms)).toEqual([{ discoveryId: "first-discovery", planId: "next-start", mode: "start", startPath: "/" }]);

  const replacement = discovery();
  replacement.discoveryId = "replacement";
  replacement.plans[0].label = "other-project — dev";
  await page.evaluate(next => { (window as any).setupTest.next = next; (window as any).setupTest.pending = false; }, replacement);
  await page.locator(".change-project").click();
  await expect(page.locator(".guided-intro")).toContainText("other-project.");
  await expect(page.locator(".project-setup")).toHaveAttribute("data-view", "overview");
  expect(errors).toEqual([]);
});

test("keeps diagnostics visible and blocks invalid plans", async ({ page }) => {
  await mockDesktop(page);
  const broken = discovery();
  broken.discoveryId = "broken";
  broken.plans = [{ ...broken.plans[0], diagnostics: [{ level: "error", code: "missing-dependencies", message: "Install dependencies before continuing." }] }];
  await page.evaluate(next => { (window as any).setupTest.next = next; }, broken);
  await page.locator(".change-project").click();
  await expect(page.getByRole("alert")).toContainText("Install dependencies");
  await expect(page.getByRole("button", { name: "Confirm & start", exact: true })).toBeDisabled();
  broken.discoveryId = "empty";
  broken.plans = [];
  broken.diagnostics = [{ level: "error", code: "unsupported-project", message: "No supported app found." }];
  await page.evaluate(next => { (window as any).setupTest.next = next; }, broken);
  await page.locator(".change-project").click();
  await expect(page.locator(".guided-rows")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText("No supported app found.");
  await expect(page.locator(".change-project")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm & start", exact: true })).toBeDisabled();
});

test("hover and nested transitions remain reversible, accessible and responsive", async ({ page }, testInfo) => {
  await mockDesktop(page);
  await settle(page);
  const button = page.locator(".confirmation-actions .primary");
  const original = await button.boundingBox();
  await page.locator(".change-project").hover();
  await expect(page.locator(".change-project-intent")).toHaveCSS("opacity", "1");
  expect(await button.boundingBox()).toEqual(original);
  await page.mouse.move(0, 0);
  await expect(page.locator(".change-project-idle")).toHaveCSS("opacity", "1");
  await page.locator(".review-trigger").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".change-project-intent")).toHaveCSS("opacity", "1");
  await expect(page.locator(".change-project-intent")).toHaveCSS("transition-duration", "0s");
  await page.locator(".review-trigger").click();
  await settle(page);
  for (let i = 0; i < 4; i++) {
    const sample = await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-file-index="3"]')!;
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
      const a = panel.getAnimations()[0]; a.pause(); a.currentTime = 75;
      return { opacity: Number(getComputedStyle(panel).opacity), duration: Number(a.effect!.getTiming().duration) + (a.effect!.getTiming().delay ?? 0) };
    });
    expect(sample.opacity).toBeGreaterThan(0); expect(sample.opacity).toBeLessThan(1); expect(sample.duration).toBeLessThanOrEqual(220);
  }
  await page.locator('[data-file-index="3"]').focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-file-index="3"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-trigger")).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".configure-trigger").click();
  await expect(page.locator(".guided-integration")).toHaveAttribute("inert", "");
  await page.locator(".configure-trigger").click();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await page.locator(".review-trigger").click();
    await page.locator(".guided-file-trigger").first().click();
    expect(await page.locator("main").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`setup-${width}px.png`) });
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  }
});
