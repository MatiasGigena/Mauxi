import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, text } from "../helpers/fake-provider";

test("Show at is refused while the agent holds browser control, even on the audited route", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-show-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html");

  try {
    await page.getByRole("button", { name: "Responsive audit", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await panel.getByRole("button", { name: "Run audit", exact: true }).click();
    const card = panel.locator('.finding-card:has-text("Horizontal scroll at 320–")').first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    const title = await card.locator(".finding-heading strong").innerText();
    await card.locator(".finding-summary").click();
    const show = card.getByRole("button", { name: "Show at 320px" });

    // The mobile preview already shows the audited route, so Show at needs no navigation: only resize and outline.
    const mobile = page.frameLocator('[data-testid="mobile-preview"]');
    expect(await page.frames().find((frame) => frame.url().includes("mauxiPreview=mobile"))?.url()).toContain("/audit-lab.html");
    const before = await mobile.locator("body").evaluate(() => ({ width: innerWidth, scrollY }));
    expect(before.width).not.toBe(320);

    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).owner)).toBe("agent");

    // Held by the agent: refused before resizing, outlining (which scrolls) or navigating.
    await show.click();
    await expect(page.locator(".workspace-notice")).toContainText("Return browser control to show this finding in the Mobile preview.");
    await page.waitForTimeout(1_500);
    expect(await mobile.locator("body").evaluate(() => ({ width: innerWidth, scrollY }))).toEqual(before);
    await expect(mobile.locator("[data-mauxi-overlay]", { hasText: title })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("show-refused-under-agent-control.png") });

    // Back with the human, the same button resizes the preview and outlines the element.
    await page.getByRole("button", { name: "Take back control", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).owner)).toBe("human");
    await show.click();
    await expect.poll(() => mobile.locator("body").evaluate(() => innerWidth)).toBe(320);
    await expect(mobile.locator("[data-mauxi-overlay]", { hasText: title })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("show-after-take-back.png") });
    await writeFile(testInfo.outputPath("show-control.json"), JSON.stringify({ title, before, refusedNotice: "Return browser control to show this finding in the Mobile preview." }, null, 2));
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
