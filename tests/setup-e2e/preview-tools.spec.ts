import { expect, test, type Page } from "@playwright/test";
import { mockDesktop } from "./fixtures";

async function openActions(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();

  return page.getByRole("dialog", { name: "Mobile actions", exact: true });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }, { width: 320, height: 480 }]) {
  test(`actions match the app theme without diagnostics at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const dialog = await openActions(page);
    await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(dialog).toHaveCSS("border-top-color", "rgb(232, 229, 225)");
    await expect(dialog).toHaveCSS("border-radius", "20px");
    expect(await dialog.evaluate(node => getComputedStyle(node).fontFamily)).toContain("Poppins");
    await expect(dialog.locator("details, pre, dl, .current-route")).toHaveCount(0);
    await expect(dialog).not.toContainText(/diagnostics|Document generation|Selection hierarchy|Open externally|DOM picker connected/i);
    await expect(dialog.locator(".preview-tool-action")).toHaveCount(6);
    await expect(dialog.locator(".preview-tool-action svg[aria-hidden=true]")).toHaveCount(6);
    await expect(dialog.getByRole("button", { name: "Close actions" }).locator("svg.lucide-x")).toHaveCount(1);
    const focus = dialog.getByRole("button", { name: "Focus Mobile", exact: true });
    await expect(focus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await focus.hover();
    await expect(focus).toHaveCSS("color", "rgb(185, 78, 56)");
    await expect(focus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(dialog.getByRole("button", { name: "Apply viewport" })).toHaveCSS("background-color", "rgb(24, 27, 34)");
    expect(await dialog.evaluate(node => {
      const rect = node.getBoundingClientRect();

      return { overflow: node.scrollWidth > node.clientWidth, contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
    })).toEqual({ overflow: false, contained: true });
    await page.screenshot({ path: testInfo.outputPath("preview-actions.png") });
  });
}

test("Apply viewport shares Send's primary styling and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const dialog = await openActions(page);
  const apply = dialog.getByRole("button", { name: "Apply viewport" });
  await dialog.getByRole("spinbutton", { name: "Width", exact: true }).fill("420");
  await expect(apply).toBeEnabled();
  await expect(apply.locator("svg.lucide-arrow-up-right")).toHaveAttribute("aria-hidden", "true");

  const appearance = await apply.evaluate(node => {
    const send = document.querySelector(".send-action")!;
    const surface = send.querySelector(".send-action-surface")!;
    const before = getComputedStyle(node, "::before");
    const sendBefore = getComputedStyle(surface, "::before");

    return {
      fontSize: getComputedStyle(node).fontSize === getComputedStyle(send).fontSize,
      fontWeight: getComputedStyle(node).fontWeight === getComputedStyle(send).fontWeight,
      fill: getComputedStyle(node, "::after").backgroundColor === getComputedStyle(surface, "::after").backgroundColor,
      gradient: before.backgroundImage === sendBefore.backgroundImage,
      animation: before.animationName === sendBefore.animationName && before.animationDuration === sendBefore.animationDuration,
    };
  });

  expect(appearance).toEqual({ fontSize: true, fontWeight: true, fill: true, gradient: true, animation: true });
  expect(await apply.evaluate(node => getComputedStyle(node, "::before").animationName)).toBe("launch-border-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await apply.hover();
  await expect(apply).toHaveCSS("transform", "none");
  expect(await apply.evaluate(node => getComputedStyle(node, "::before").animationName)).toBe("none");
});

test("modal traps keyboard focus, closes with Escape and returns to its opener", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const dialog = await openActions(page);
  const close = dialog.getByRole("button", { name: "Close actions" });
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(dialog.getByRole("spinbutton", { name: "Height", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(close).toHaveCSS("outline-color", "rgb(33, 143, 144)");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mobile actions", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Close actions" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Apply viewport enables only for changed dimensions and resets after applying", async ({ page }) => {
  const dialog = await openActions(page);
  const width = dialog.getByRole("spinbutton", { name: "Width", exact: true });
  const height = dialog.getByRole("spinbutton", { name: "Height", exact: true });
  const apply = dialog.getByRole("button", { name: "Apply viewport" });
  await expect(apply).toBeDisabled();
  await height.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.locator("form").dispatchEvent("submit");
  await expect(dialog).toBeVisible();
  await width.fill("420"); await expect(apply).toBeEnabled();
  await width.fill("390"); await expect(apply).toBeDisabled();
  await width.fill("0390"); await expect(apply).toBeDisabled();
  await height.fill("900"); await expect(apply).toBeEnabled();
  await height.fill("844"); await expect(apply).toBeDisabled();
  await width.fill("420"); await height.fill("900");
  await dialog.getByRole("button", { name: "Close actions" }).press("Shift+Tab");
  await expect(apply).toBeFocused();
  await apply.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("mobile-preview")).toHaveAttribute("width", "420");
  await expect(page.getByTestId("mobile-preview")).toHaveAttribute("height", "900");
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await expect(width).toHaveValue("420"); await expect(height).toHaveValue("900");
  await expect(apply).toBeDisabled();
});

test("viewport edits validate empty, fractional and out-of-range values before applying", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const dialog = await openActions(page);
  const width = dialog.getByRole("spinbutton", { name: "Width", exact: true });
  const height = dialog.getByRole("spinbutton", { name: "Height", exact: true });
  const apply = dialog.getByRole("button", { name: "Apply viewport" });

  for (const value of ["", "239", "3841", "390.5"]) {
    await width.fill(value); await apply.click();
    await expect(dialog).toBeVisible();
    expect(await width.evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(false);
    await expect(page.getByTestId("mobile-preview")).toHaveAttribute("width", "390");
  }

  await width.fill("420");

  for (const value of ["", "239", "2161", "844.5"]) {
    await height.fill(value); await apply.click();
    await expect(dialog).toBeVisible();
    expect(await height.evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(false);
  }

  await height.fill("900"); await height.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("mobile-preview")).toHaveAttribute("width", "420");
  await expect(page.getByTestId("mobile-preview")).toHaveAttribute("height", "900");
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await expect(width).toHaveValue("420"); await expect(height).toHaveValue("900");
});

test("disconnected actions stay disabled and reduced motion preserves focus and layout", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const dialog = await openActions(page);
  await expect(dialog.getByRole("button", { name: "Select in Mobile", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Copy route to desktop", exact: true })).toBeDisabled();
  const focus = dialog.getByRole("button", { name: "Focus Mobile", exact: true });
  await focus.hover(); await page.mouse.down();
  await expect(focus).toHaveCSS("transform", "none");
  await expect(focus).toHaveCSS("transition-duration", "0s");
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-preview-id="desktop"]')).toBeHidden();
});
