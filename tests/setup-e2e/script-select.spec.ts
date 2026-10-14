import { expect, test, type Page } from "@playwright/test";
import { discovery, mockDesktop } from "./fixtures";


function setupTest(page: Page) {
  return page.evaluateHandle(() => {
    if (!window.setupTest) throw new Error("mockDesktop did not install setupTest");

    return window.setupTest;
  });
}

async function openConfiguration(page: Page) {
  await mockDesktop(page);
  await page.locator(".configure-trigger").click();
  await expect(page.getByRole("combobox", { name: /Application and script/ })).toBeVisible();
}

async function replacePlans(page: Page, data: ReturnType<typeof discovery>) {
  await (await setupTest(page)).evaluate((state, next) => { state.next = next; }, data);
  await page.locator(".change-project").click();
  await page.locator(".configure-trigger").click();
}

test("command-only menu fades details out and back without layout shift", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openConfiguration(page);
  const trigger = page.getByRole("combobox", { name: /Application and script/ });
  const details = page.locator(".technical-details");
  await expect(trigger).toHaveText("npm run dev");
  const height = await page.locator(".project-setup").evaluate((node: HTMLElement) => node.offsetHeight);
  await trigger.click();
  await expect(page.getByRole("option")).toHaveText(["npm run dev", "pnpm run start"]);
  await expect(details).toHaveAttribute("aria-hidden", "true");
  await expect(details).toHaveAttribute("inert", "");
  await expect(details).toHaveCSS("opacity", "0");
  await expect(details).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -6)");
  await expect(details).toHaveCSS("transition-duration", "0.09s");
  expect(await page.locator(".project-setup").evaluate((node: HTMLElement) => node.offsetHeight)).toBe(height);
  await expect(trigger).toHaveCSS("border-left-width", "0px");
  await expect(trigger).toHaveCSS("border-right-width", "0px");
  await expect(trigger).toHaveCSS("background-image", "none");
  await page.screenshot({ path: testInfo.outputPath("inline-open.png") });
  await page.getByRole("option", { name: /pnpm run start/ }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("pnpm run start");
  await expect(details).toHaveCSS("opacity", "1");
  await expect(details).toHaveCSS("transition-duration", "0.16s, 0.16s");
  await expect(details).toHaveAttribute("aria-hidden", "false");
  await expect(details).not.toHaveAttribute("inert");
  await expect(details).toContainText("Next.js");
  await expect(page.locator(".project-path")).toHaveText("/projects/rondo/storefront");
  await trigger.click();
  await page.locator(".guided-intro").click();
  await expect(details).toHaveCSS("opacity", "1");
  await trigger.click(); await trigger.click(); await trigger.click();
  await expect(details).toHaveCSS("opacity", "0");
  await trigger.click();
  await expect(details).toHaveCSS("opacity", "1");
  await trigger.click();
  await page.locator(".configure-trigger").click();
  await page.locator(".configure-trigger").click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(details).toHaveCSS("opacity", "1");
  expect(errors).toEqual([]);
});

test("keyboard selection, typeahead, Tab and nested Escape are immediate", async ({ page }) => {
  await openConfiguration(page);
  const trigger = page.getByRole("combobox", { name: /Application and script/ });
  const details = page.locator(".technical-details");
  await trigger.focus();
  await trigger.press("ArrowDown");
  await expect(details).toHaveCSS("opacity", "0");
  await expect(details).toHaveCSS("transition-duration", "0s");
  await expect(page.locator(".script-select-popup")).toHaveCSS("animation-name", "none");
  await trigger.press("End");
  await expect(page.getByRole("option").last()).toHaveAttribute("data-active", "true");
  await trigger.press("Enter");
  await expect(trigger).toHaveText("pnpm run start");
  await expect(details).toHaveCSS("opacity", "1");
  await expect(details).toHaveCSS("transition-duration", "0s");
  await trigger.press("n");
  await expect(page.getByRole("option").first()).toHaveAttribute("data-active", "true");
  await trigger.press("Enter");
  await expect(trigger).toHaveText("npm run dev");
  await trigger.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".project-setup")).toHaveAttribute("data-view", "configure");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await trigger.press("Tab");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".change-project")).toBeFocused();
  await expect(details).toHaveCSS("transition-duration", "0s");
  await trigger.focus();
  await trigger.press("Escape");
  await expect(page.locator(".project-setup")).toHaveAttribute("data-view", "overview");
});

test("duplicate commands retain distinct plan identities and long lists scroll internally", async ({ page }) => {
  await openConfiguration(page);
  const data = discovery(); data.discoveryId = "many-plans";
  data.plans = Array.from({ length: 18 }, (_, index) => ({ ...data.plans[0], id: `plan-${index}`, appRoot: `/projects/app-${index}`, label: `app-${index} — dev` }));
  await replacePlans(page, data);
  const trigger = page.getByRole("combobox", { name: /Application and script/ });
  const before = await page.locator(".launch-screen").evaluate(node => node.scrollTop);
  await trigger.press("End");
  await expect(page.getByRole("option")).toHaveCount(18);
  expect(await page.locator(".script-select-options").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator(".launch-screen").evaluate(node => node.scrollTop)).toBe(before);
  await trigger.press("Enter");
  await expect(page.locator(".project-path")).toHaveText("/projects/app-17");
  await trigger.click();
  await expect(page.getByRole("option", { name: "npm run dev (/projects/app-17)", exact: true })).toHaveAttribute("aria-selected", "true");
  await trigger.press("Home");
  await trigger.press("Enter");
  await expect(page.locator(".project-path")).toHaveText("/projects/app-0");
});

test("one available command is disabled, and busy state disables selection", async ({ page }) => {
  await openConfiguration(page);
  const single = discovery(); single.discoveryId = "one-plan"; single.plans = single.plans.slice(0, 1);
  await replacePlans(page, single);
  const trigger = page.getByRole("combobox", { name: /Application and script/ });
  await expect(trigger).toBeDisabled();
  await expect(trigger).toHaveText("npm run dev");
  await expect(page.locator(".technical-details")).toHaveCSS("opacity", "1");
  const multiple = discovery(); multiple.discoveryId = "multiple-again";
  await replacePlans(page, multiple);
  await expect(trigger).toBeEnabled();
  await (await setupTest(page)).evaluate(state => { state.pending = true; state.next = null; });
  await page.locator(".change-project").click();
  await expect(trigger).toBeDisabled();
  await (await setupTest(page)).evaluate(state => { state.release!(); });
  await expect(trigger).toBeEnabled();
});

test("reduced motion removes details movement and menu animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openConfiguration(page);
  const trigger = page.getByRole("combobox", { name: /Application and script/ });
  await trigger.click();
  await expect(page.locator(".script-select-popup")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".technical-details")).toHaveCSS("opacity", "0");
  await expect(page.locator(".technical-details")).toHaveCSS("transform", "none");
  await expect(page.locator(".technical-details")).toHaveCSS("transition-duration", "0s");
  await trigger.click();
  await expect(page.locator(".technical-details")).toHaveCSS("opacity", "1");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("selection and detail restoration work on narrow touch screens", async ({ page }, testInfo) => {
    await openConfiguration(page);
    const trigger = page.getByRole("combobox", { name: /Application and script/ });

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await trigger.tap();
      await expect(page.locator(".technical-details")).toHaveCSS("opacity", "0");
      expect(await page.locator(".launch-screen").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`inline-${width}.png`) });
      await page.getByRole("option", { name: /pnpm run start/ }).tap();
      await expect(trigger).toHaveText("pnpm run start");
      await expect(page.locator(".technical-details")).toHaveCSS("opacity", "1");
      await expect(page.locator(".technical-details")).toContainText("Next.js");
    }
  });
});
