import { expect, test } from "@playwright/test";
import { discovery, mockDesktop, selectScript } from "./fixtures";

async function captureEntrance(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as any).entranceStarts = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);

      if (typeof options === "object" && options.id === "setup-entrance") {
        (window as any).entranceStarts++;
        animation.pause(); animation.currentTime = 0;
      }

      return animation;
    };
  });
  await mockDesktop(page);
}

test("setup enters once with a short stagger, without layout shift or replay on interaction", async ({ page }, testInfo) => {
  await captureEntrance(page);

  const entry = await page.evaluate(() => document.getAnimations().filter(a => a.id === "setup-entrance").map(a => ({
    duration: a.effect!.getTiming().duration, delay: a.effect!.getTiming().delay,
    target: ((a.effect as KeyframeEffect).target as HTMLElement).className,
    frames: (a.effect as KeyframeEffect).getKeyframes(),
  })));

  expect(entry).toHaveLength(5);
  expect(entry.map(a => a.target)).toEqual(["launch-brand setup-brand", "guided-intro", "configure-trigger", "guided-integration", "confirmation-actions"]);
  expect(entry.map(a => a.delay)).toEqual([0, 20, 40, 60, 80]);
  expect(entry.every(a => Number(a.duration) + (a.delay ?? 0) < 300)).toBe(true);
  expect(entry.every(a => a.frames[0].opacity === "0" && a.frames[1].opacity === "1")).toBe(true);
  expect(entry.every(a => !a.frames.some(frame => "height" in frame || "width" in frame || "margin" in frame))).toBe(true);
  const height = await page.locator(".project-setup").evaluate(node => (node as HTMLElement).offsetHeight);
  await page.evaluate(() => document.getAnimations().filter(a => a.id === "setup-entrance").forEach(a => { a.currentTime = 120; }));
  const opacities = await page.locator(".launch-brand, .guided-intro, .configure-trigger, .guided-integration, .confirmation-actions").evaluateAll(nodes => nodes.map(node => Number(getComputedStyle(node).opacity)));
  expect(opacities.every(value => value > 0 && value < 1)).toBe(true);
  expect(opacities[0]).toBeGreaterThan(opacities[1]);
  expect(opacities[1]).toBeGreaterThan(opacities[2]);
  expect(opacities[2]).toBeGreaterThan(opacities[3]);
  expect(opacities[3]).toBeGreaterThan(opacities[4]);
  await page.screenshot({ path: testInfo.outputPath("entry-midpoint.png") });
  await page.evaluate(() => document.getAnimations().filter(a => a.id === "setup-entrance").forEach(a => a.finish()));
  await page.waitForFunction(() => !document.getAnimations().some(a => a.id === "setup-entrance"));
  expect(await page.locator(".project-setup").evaluate(node => (node as HTMLElement).offsetHeight)).toBe(height);
  const starts = await page.evaluate(() => (window as any).entranceStarts);
  await page.locator(".configure-trigger").click();
  await selectScript(page, "pnpm run start");
  await page.keyboard.press("Escape");
  await page.locator(".review-trigger").click();
  await page.locator(".guided-file-trigger").click();
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).setupTest.next = null; });
  await page.locator(".change-project").click();
  await expect(page.locator(".change-project")).toBeEnabled();
  expect(await page.evaluate(() => (window as any).entranceStarts)).toBe(starts);
  const replacement = discovery(); replacement.discoveryId = "new-entry";
  await page.evaluate(next => { (window as any).setupTest.next = next; }, replacement);
  await page.locator(".change-project").click();
  await expect.poll(() => page.evaluate(() => (window as any).entranceStarts)).toBeGreaterThan(starts);
});

test("entry can be interrupted immediately by keyboard or pointer disclosures", async ({ page }) => {
  await captureEntrance(page);
  await page.evaluate(() => {
    document.getAnimations().filter(a => a.id === "setup-entrance").forEach(a => { a.currentTime = 120; });
    document.querySelector<HTMLButtonElement>(".configure-trigger")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  expect(await page.evaluate(() => document.getAnimations().some(a => a.id === "setup-entrance"))).toBe(false);
  await expect(page.locator(".configure-trigger")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".guided-inline-config")).toBeVisible();
  await page.locator(".configure-trigger").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".project-setup")).toHaveAttribute("data-view", "overview");
  const replacement = discovery(); replacement.discoveryId = "keyboard-entry";
  await page.evaluate(next => { (window as any).setupTest.next = next; }, replacement);
  await page.locator(".change-project").click();
  await page.locator(".configure-trigger").focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.getAnimations().some(a => a.id === "setup-entrance"))).toBe(false);
  await expect(page.locator(".launch-brand")).toHaveCSS("opacity", "1");
  await expect(page.locator(".guided-intro")).toHaveCSS("opacity", "1");
  await expect(page.locator(".guided-inline-config")).toHaveCSS("opacity", "1");
});

test("reduced motion uses a simultaneous fade without translation or stagger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await captureEntrance(page);
  const entry = await page.evaluate(() => document.getAnimations().filter(a => a.id === "setup-entrance").map(a => ({ duration: a.effect!.getTiming().duration, delay: a.effect!.getTiming().delay, frames: (a.effect as KeyframeEffect).getKeyframes() })));
  expect(entry).toHaveLength(5);
  expect(entry.every(a => a.duration === 120 && a.delay === 0)).toBe(true);
  expect(entry.every(a => a.frames.every(frame => !("transform" in frame)))).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.evaluate(() => document.getAnimations().some(a => a.id === "setup-entrance"))).toBe(false);
});
