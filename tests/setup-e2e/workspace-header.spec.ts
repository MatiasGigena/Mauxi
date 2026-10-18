import { expect, test, type Page } from "@playwright/test";
import type { BrowserState } from "../../src/application/browser-contract";
import type { CanvasState } from "../../src/application/canvas-state";
import { mockDesktop } from "./fixtures";

declare global {
  interface Window {
    workspaceHeaderSaves?: Array<{ workspaceId: string; canvas: CanvasState }>;
    workspaceHeaderBrowserState?: (state: BrowserState) => void;
  }
}

async function openWorkspace(page: Page) {
  await mockDesktop(page);
  await page.evaluate(() => {
    const saves: Array<{ workspaceId: string; canvas: CanvasState }> = [];
    window.workspaceHeaderSaves = saves;
    window.mauxi!.saveCanvas = async input => { saves.push(input); };

    window.mauxi!.onBrowserState = listener => { window.workspaceHeaderBrowserState = listener;

    return () => {}; };
  });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".topbar")).toBeVisible();
}

for (const width of [320, 768, 1440]) {
  test(`workspace header contains only logo, repository title, audit and zoom at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const header = page.locator(".topbar");
    await expect(header.locator("img")).toBeVisible();
    await expect(header.locator("strong")).toHaveText("rondo");
    await expect(header.locator("button, a, select, input")).toHaveCount(3);
    await expect(header.getByRole("button", { name: "Responsive audit", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Project menu" })).toHaveAttribute("aria-expanded", "false");
    await expect(header.getByRole("slider", { name: "Camera zoom" })).toBeVisible();
    await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(header).toHaveCSS("border-width", "0px");
    await expect(header).toHaveCSS("box-shadow", "none");

    for (const island of [header.locator(".brand"), header.locator(".zoom")]) {
      await expect(island).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(island).toHaveCSS("border-color", "rgb(232, 229, 225)");
      await expect(island).toHaveCSS("border-radius", "999px");
    }

    await expect(header.locator("input")).toHaveCSS("accent-color", "rgb(33, 143, 144)");
    const headerBounds = (await header.boundingBox())!;
    const backgroundBounds = (await page.locator(".canvas-background").boundingBox())!;
    expect(backgroundBounds.y).toBe(0);
    expect((await page.getByTestId("canvas").boundingBox())!.y).toBe(0);
    await expect(header).toHaveCSS("position", "absolute");
    expect(headerBounds.y).toBe(12);
    const brandBounds = (await header.locator(".brand").boundingBox())!;
    const zoomBounds = (await header.locator(".zoom").boundingBox())!;
    expect(zoomBounds.x - brandBounds.x - brandBounds.width).toBeGreaterThanOrEqual(12);

    if (width >= 768) expect(brandBounds.width).toBeLessThan(200);
    await expect(header.locator(".connection, .browser-control, .fixture-switch")).toHaveCount(0);
    await header.locator("strong").evaluate(node => { node.textContent = "a-very-long-repository-name-that-must-not-displace-the-zoom-control"; });
    expect(await header.evaluate(node => {
      const rect = node.getBoundingClientRect();

      return node.scrollWidth <= node.clientWidth && [...node.querySelectorAll("img, strong, input")].every(child => {
        const bounds = child.getBoundingClientRect();

        return bounds.left >= rect.left && bounds.right <= rect.right;
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-header-${width}.png`) });
  });
}

test("pills, previews and chat share the same subtle shadow", async ({ page }) => {
  await openWorkspace(page);
  const shadow = await page.locator(".brand").evaluate(node => getComputedStyle(node).boxShadow);
  expect(shadow).not.toBe("none");

  for (const selector of [".zoom", '[data-preview-id="desktop"]', '[data-preview-id="mobile"]', ".chat-surface"]) {
    await expect(page.locator(selector)).toHaveCSS("box-shadow", shadow);
  }

  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Shadow check");
  const focused = await page.locator(".chat-surface").evaluate(node => getComputedStyle(node).boxShadow);
  expect(focused.endsWith(shadow)).toBe(true);
  await expect(page.locator(".chat-surface")).toHaveCSS("border-color", "rgb(33, 143, 144)");
});

test("previews remain visible and clickable between the floating pills", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  const board = page.locator('[data-preview-id="desktop"]');
  const bounds = (await board.locator(".artboard-header").boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  await page.mouse.move(x, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, 24, { steps: 8 });
  await page.mouse.up();
  const moved = (await board.boundingBox())!;
  expect(moved.y).toBeLessThan(12);
  expect(await page.evaluate(x => !!document.elementFromPoint(x, 24)?.closest('.artboard-header'), x)).toBe(true);
  const y = moved.y + 50;
  expect(y).toBeLessThan(60);
  await page.mouse.click(x, y);
  await expect(board).toHaveAttribute("data-interacting", "true");
  expect(await page.locator(".brand").evaluate(node => {
    const rect = node.getBoundingClientRect();

    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
});

test("zoom updates both previews and persists; keyboard supports the complete range", async ({ page }) => {
  await openWorkspace(page);
  const zoom = page.getByRole("slider", { name: "Camera zoom" });

  for (const value of ["0.25", "0.73", "1", "2"]) {
    await zoom.fill(value);
    const percentage = `${Math.round(Number(value) * 100)}%`;
    await expect(page.locator(".zoom span")).toHaveText(percentage);
    await expect(zoom).toHaveAttribute("aria-valuetext", percentage);

    for (const id of ["desktop", "mobile"]) {
      await expect.poll(() => page.getByTestId(`${id}-preview`).evaluate(node => node.style.transform)).toBe(`scale(${Number(value)})`);
    }

    await expect.poll(() => page.evaluate(() => window.workspaceHeaderSaves?.at(-1)?.canvas.camera.zoom)).toBe(Number(value));
  }

  await zoom.focus();
  await page.keyboard.press("Home");
  await expect(zoom).toHaveValue("0.1");
  await page.keyboard.press("ArrowRight");
  await expect(zoom).toHaveValue("0.11");
  await page.keyboard.press("End");
  await expect(zoom).toHaveValue("2");
});

test("agent lock disables zoom without adding header actions; emergency return stays available", async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(() => window.workspaceHeaderBrowserState!({ workspaceId: "test-workspace", owner: "agent", generation: 1, releasing: false, activity: "Checking previews", remaining: 60, evidence: [] }));
  await expect(page.getByRole("slider", { name: "Camera zoom" })).toBeDisabled();
  await expect(page.locator(".topbar button")).toHaveCount(2);
  await expect(page.locator(".topbar").getByRole("button", { name: "Responsive audit", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Emergency take back control", exact: true }).click();
  await page.evaluate(() => window.workspaceHeaderBrowserState!({ workspaceId: "test-workspace", owner: "human", generation: 2, releasing: false, activity: "", remaining: 0, evidence: [] }));
  await expect(page.getByRole("slider", { name: "Camera zoom" })).toBeEnabled();
});
