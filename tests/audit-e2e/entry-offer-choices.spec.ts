import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The two ways out of the entry audit's quiet canvas besides the offer's button: Fit everything while the audit runs,
 * and the offer's dismiss under reduced motion (where no exit animation runs to end it).
 */

/** The repeatable record: what the canvas showed after each way out. */
interface Summary { fit?: { captures: number; offer: number }; dismiss?: { reducedMotion: boolean; offerAfterDismiss: number } }

const summary: Summary = {};

async function open(testInfo: { outputPath: (...parts: string[]) => string }, name: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath(`${name}-profile`), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-lab.html" }, recordVideo: { dir: testInfo.outputPath(`${name}-video`) } });

  return { application, page: await application.firstWindow() };
}

async function record(): Promise<void> {
  await writeFile(path.resolve("test-results/audit/entry-offer-choices-summary.json"), JSON.stringify(summary, null, 2));
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Responsive audit" });
const offer = (page: Page) => page.getByRole("status", { name: "Audit snapshots ready" });

/** Every live preview lies fully inside the window. */
async function previewsInView(page: Page): Promise<boolean> {
  return page.evaluate(() => [...document.querySelectorAll(".artboard[data-preview-id]")].every((node) => { const box = node.getBoundingClientRect();

    return box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; }));
}

test("Fit everything during the entry audit shows the forming snapshots it fits, and no offer follows", async ({}, testInfo) => {
  const { application, page } = await open(testInfo, "fit");

  try {
    await expect(panel(page).getByRole("status")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".snapshot-board")).toHaveCount(0);
    await page.getByRole("button", { name: "Fit everything in view" }).click();
    // What the camera fits is on the canvas: the sheet forms in view beside the live previews.
    await expect(page.locator(".audit-sheet")).toHaveCount(1);
    await expect.poll(() => page.locator(".snapshot-board").count()).toBeGreaterThan(0);
    await expect.poll(() => previewsInView(page), { timeout: 5_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("fit-during-entry.png") });

    await expect(panel(page).getByRole("button", { name: "Re-run", exact: true })).toBeVisible({ timeout: 150_000 });
    const captures = await page.evaluate(() => document.querySelectorAll(".snapshot-board").length);
    // The snapshots are already out: nothing is left to offer.
    await page.waitForTimeout(1_500);
    await expect(offer(page)).toHaveCount(0);
    await expect(page.locator(".snapshot-board[data-state]")).toHaveCount(0);
    summary.fit = { captures, offer: 0 };
    await page.screenshot({ path: testInfo.outputPath("fit-after-entry.png") });
    await record();
  } finally { await application.close(); }
});

test("under reduced motion the offer's dismiss takes it away at once", async ({}, testInfo) => {
  const { application, page } = await open(testInfo, "still");

  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(offer(page)).toBeVisible({ timeout: 150_000 });
    await offer(page).getByRole("button", { name: "Dismiss" }).click();
    // No exit animation runs under reduced motion; the card must not wait for one.
    await expect(offer(page)).toHaveCount(0, { timeout: 1_000 });
    await expect(page.locator(".snapshot-board")).toHaveCount(0);
    summary.dismiss = { reducedMotion: true, offerAfterDismiss: await offer(page).count() };
    await page.screenshot({ path: testInfo.outputPath("dismissed-still.png") });
    await record();
  } finally { await application.close(); }
});
