import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, text } from "../helpers/fake-provider";

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

// The audit sheet on the Vite audit lab: peeks with an animated camera that Esc undoes.
test("audit sheet: peek and return", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-peek-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html", "Local model");
  const evidence: Array<{ step: string; data: object }> = [];
  const save = () => writeFile(testInfo.outputPath("audit-peek-evidence.json"), JSON.stringify(evidence, null, 2));

  try {
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await expect(panel.getByRole("button", { name: "Re-run" })).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".workspace-notice")).toHaveCount(0, { timeout: 15_000 });
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

    await save();
  } finally {
    await save();
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
