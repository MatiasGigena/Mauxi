import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sweepWidths } from "../../src/application/audit-contract";
import { showSnapshots } from "../helpers/entry-audit";
import { launch, text } from "../helpers/fake-provider";

const LAB_CSS = path.resolve("fixtures/vite/src/audit-lab/audit-lab.css");
const PLANTED = "width: 600px; /* planted: fixed width */";
const FIXED = "max-width: 600px; flex-wrap: wrap;";

/** The camera zoom on every animation frame for ms milliseconds. */
function recordZoom(page: Page, ms: number) {
  return page.evaluate((ms) => new Promise<number[]>((resolve) => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!;
    const values: number[] = [];
    const end = performance.now() + ms;

    const tick = () => {
      values.push(Number(input.value));

      if (performance.now() < end) requestAnimationFrame(tick); else resolve(values);
    };

    requestAnimationFrame(tick);
  }), ms);
}

/** Waits until the camera stops moving and returns its zoom and a tile's screen box. */
async function settled(page: Page, profileId = "phone-sm") {
  const read = () => page.evaluate((id) => {
    const rect = document.querySelector(`.snapshot-board[data-profile-id="${id}"]`)!.getBoundingClientRect();

    return { zoom: Number(document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
  }, profileId);

  let last = await read();

  await expect.poll(async () => {
    const now = await read();
    const still = JSON.stringify(now) === JSON.stringify(last);
    last = now;

    return still;
  }, { intervals: [150], timeout: 10_000 }).toBe(true);

  return last;
}

const previewWidth = (page: Page, id: "desktop" | "mobile") => page.locator(`[data-testid="${id}-preview"]`).evaluate((frame) => Number(frame.getAttribute("width")));

// Tier 3 of the audit sheet on the Vite audit lab: peeks with an animated camera that Esc undoes, the width scope as a
// slider that resizes the live previews, and ghosts of findings a re-run no longer reports.
test("audit sheet: peek and return, width scope scrubbing and resolved ghosts", async ({}, testInfo) => {
  const original = await readFile(LAB_CSS, "utf8");
  expect(original).toContain(PLANTED);
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-peek-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html", "Local model");
  const evidence: Array<{ step: string; data: object }> = [];
  const save = () => writeFile(testInfo.outputPath("audit-peek-evidence.json"), JSON.stringify(evidence, null, 2));

  try {
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await expect(panel.getByRole("button", { name: "Re-run" })).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".workspace-notice")).toHaveCount(0, { timeout: 15_000 });
    await showSnapshots(page);
    const overview = await settled(page);
    const tablet = page.locator('.snapshot-board[data-profile-id="tablet"]');
    await expect(tablet).toHaveAttribute("data-cropped", "true");

    // Clicking a tile's page peeks at it: the full page opens and the camera flies there over several frames.
    const frames = recordZoom(page, 700);
    await tablet.locator(".snapshot-surface").click({ position: { x: 20, y: 20 } });
    const zooms = await frames;
    const peeked = await settled(page, "tablet");
    evidence.push({ step: "peek tablet", data: { overview, peeked, frames: zooms.length, distinct: new Set(zooms).size } });
    expect(new Set(zooms).size).toBeGreaterThanOrEqual(4);
    expect(zooms.at(-1)).toBe(peeked.zoom);
    expect(peeked.width).toBeGreaterThan(300);
    await expect(tablet).not.toHaveAttribute("data-cropped");
    await expect(tablet).toHaveAttribute("data-peek", "true");
    await expect(page.locator(".peek-bar")).toContainText("Peeking at Tablet");
    await page.screenshot({ path: testInfo.outputPath("01-peek.png") });

    // Esc flies back to the overview and crops the tile again.
    await page.keyboard.press("Escape");
    await expect(page.locator(".peek-bar")).toHaveCount(0);
    const back = await settled(page);
    expect(back).toEqual(overview);
    await expect(tablet).toHaveAttribute("data-cropped", "true");

    // Under reduced motion a peek (from the caption, by keyboard) jumps in one frame; Back returns.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Peek at the Small phone snapshot" }).focus();
    const instant = recordZoom(page, 400);
    await page.keyboard.press("Enter");
    const jumps = await instant;
    evidence.push({ step: "reduced-motion peek", data: { distinct: new Set(jumps).size } });
    expect(new Set(jumps).size).toBeLessThanOrEqual(2);
    await page.locator(".peek-bar").getByRole("button", { name: /Back/ }).click();
    expect(await settled(page)).toEqual(overview);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // The width scope in the top bar is a slider with a mark per measured width: a drag resizes the Mobile preview to the
    // width under the pointer, and the scope holds still under the pointer while the previews change.
    const strip = page.getByRole("slider", { name: "Resize a live preview to a measured width" });
    expect(await strip.locator(".scope-bar").count()).toBe(sweepWidths().length);
    const plot = (await strip.locator(".scope-plot").boundingBox())!;
    const y = plot.y + plot.height / 2;

    const at = async (width: number) => { const bar = (await strip.locator(`.scope-bar[data-width="${width}"]`).boundingBox())!;

      return bar.x + bar.width / 2; };

    await page.mouse.move(await at(320), y);
    await page.mouse.down();
    await page.mouse.move(await at(560), y, { steps: 6 });
    await expect.poll(() => previewWidth(page, "mobile")).toBe(560);
    expect((await strip.locator(".scope-plot").boundingBox())!.x).toBeCloseTo(plot.x, 0);
    await page.mouse.move(await at(768), y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => previewWidth(page, "mobile")).toBe(768);
    await expect(strip).toHaveAttribute("aria-valuenow", "768");
    await page.screenshot({ path: testInfo.outputPath("02-scrubbed-768.png") });

    // Arrow keys step through the measured widths; End widens the Desktop preview and pushes Mobile along beside it.
    await strip.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => previewWidth(page, "mobile")).toBe(784);
    await page.keyboard.press("End");
    await expect.poll(() => previewWidth(page, "desktop")).toBe(1920);
    const desktop = (await page.locator('.artboard[data-preview-id="desktop"]').boundingBox())!;
    const mobile = (await page.locator('.artboard[data-preview-id="mobile"]').boundingBox())!;
    expect(mobile.x).toBeGreaterThanOrEqual(desktop.x + desktop.width);
    evidence.push({ step: "scrub", data: { mobile: await previewWidth(page, "mobile"), desktop: await previewWidth(page, "desktop") } });
    await page.screenshot({ path: testInfo.outputPath("03-scrubbed-desktop.png") });

    // While the agent holds the browser, the strip refuses to resize anything.
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    await expect(page.getByRole("button", { name: "Emergency take back control" })).toBeVisible();
    // Handing over says so in one quiet line with the way back, not a paragraph about route linking.
    const control = page.locator(".agent-control");
    await expect(control).toHaveText("Agent has controlTake back");
    expect((await control.boundingBox())!.height).toBeLessThanOrEqual(37);
    await expect(page.getByText("Route linking paused", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("03b-agent-control.png") });
    await strip.focus();
    await page.keyboard.press("Home");
    await expect(page.locator(".workspace-notice")).toContainText("Return browser control to resize the previews.");
    expect(await previewWidth(page, "mobile")).toBe(784);
    await expect(strip).toHaveAttribute("aria-valuenow", "1920");
    await page.getByRole("button", { name: "Emergency take back control" }).click();
    await expect(page.getByRole("button", { name: "Emergency take back control" })).toHaveCount(0);

    // Fix the planted overflow and re-run: what the run no longer reports stays on its tiles as a dashed ghost, and
    // hovering it in the Resolved list spotlights it.
    await writeFile(LAB_CSS, original.replace(PLANTED, FIXED));
    await panel.getByRole("button", { name: "Re-run", exact: true }).click();
    await expect(panel.getByRole("button", { name: /Resolved since last run/ })).toBeVisible({ timeout: 150_000 });
    await expect(panel.getByRole("button", { name: "Re-run", exact: true })).toBeEnabled({ timeout: 60_000 });
    const ghosts = page.locator('.snapshot-board[data-profile-id="phone-sm"] .resolved-marker');
    await expect(ghosts).not.toHaveCount(0);
    const markers = await page.locator('.snapshot-board[data-profile-id="phone-sm"] .finding-marker').count();
    await expect(panel.getByRole("button", { name: /Resolved since last run/ })).toHaveAttribute("aria-expanded", "true");
    const resolved = panel.locator(".resolved-group li").first();
    const resolvedId = (await resolved.getAttribute("data-finding-id"))!;
    await resolved.hover();
    await expect(page.locator(".resolved-marker[data-spotlit]").first()).toBeAttached();
    await expect(page.locator('.snapshot-board[data-spotlight="lit"]:has(.resolved-marker[data-spotlit])').first()).toBeAttached();
    evidence.push({ step: "resolved", data: { resolvedId, ghosts: await ghosts.count(), markers } });
    await page.screenshot({ path: testInfo.outputPath("04-resolved-ghosts.png") });
    await save();
  } finally {
    await save();
    await writeFile(LAB_CSS, original);
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
