import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

const rows = [
  { selector: ".configure-trigger", label: "Configure", close: "Close configuration" },
  { selector: ".review-trigger", label: "Review", close: "Close review" },
];

test("both setup rows reveal labels without a filled hover or layout shift", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockDesktop(page);
  await page.mouse.move(0, 0);

  for (const { selector, label, close } of rows) {
    const row = page.locator(selector);
    const text = row.locator(".row-link-label");
    const icon = row.locator(".row-link > svg");
    await expect(text).toHaveCSS("opacity", "0");
    await expect(row).toHaveAccessibleName(new RegExp(label));
    await expect(icon).toHaveCSS("opacity", "1");
    await expect(row).toHaveCSS("opacity", "1");
    const bounds = await icon.boundingBox();
    await row.hover();
    await expect(text).toHaveCSS("opacity", "1");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(await icon.boundingBox()).toEqual(bounds);
    await page.screenshot({ path: testInfo.outputPath(`${label.toLowerCase()}-reveal.png`) });
    await page.mouse.down();
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.up();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(0, 0);
    await expect(text).toHaveText(close);
    await expect(text).toHaveCSS("opacity", "1");
    await row.focus();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: /Let’s work/ }).click();
    await expect(text).toHaveCSS("opacity", "0");
    await row.hover(); await page.mouse.move(0, 0); await row.hover();
    await expect(text).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(text).toHaveCSS("opacity", "0");
  }

  expect(errors).toEqual([]);
});

test("keyboard reveals are immediate and reduced motion has no label translation", async ({ page }) => {
  await mockDesktop(page);
  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab");

  for (const { selector } of rows) {
    const row = page.locator(selector);
    const text = row.locator(".row-link-label");
    await row.focus();
    await expect(row).toBeFocused();
    await expect(text).toHaveCSS("opacity", "1");
    await expect(text).toHaveCSS("transition-duration", "0s");
    await expect(text).toHaveCSS("transform", "none");
    await row.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await row.press("Escape");
    await expect(row).toHaveAttribute("aria-expanded", "false");
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("heading", { name: /Let’s work/ }).click();

  for (const { selector } of rows) {
    const text = page.locator(`${selector} .row-link-label`);
    await expect(text).toHaveCSS("transform", "none");
    await page.locator(selector).hover();
    await expect(text).toHaveCSS("opacity", "1");
    await expect(text).toHaveCSS("transition-duration", "0s");
    await expect(text).toHaveCSS("transform", "none");
  }
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("both labels remain visible without hover", async ({ page }) => {
    await mockDesktop(page);

    for (const { selector, close } of rows) {
      const row = page.locator(selector);
      const text = row.locator(".row-link-label");
      await expect(text).toHaveCSS("opacity", "1");
      await expect(text).toHaveCSS("transform", "none");
      await row.tap();
      await expect(row).toHaveAttribute("aria-expanded", "true");
      await expect(text).toHaveText(close);
      await row.tap();
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await expect(text).toHaveCSS("opacity", "1");
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
