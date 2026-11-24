import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch, text } from "../helpers/fake-provider";

const output = path.resolve("docs/images/mauxi-workspace.png");

// Regenerates the README screenshot: the Vite audit lab right after the entry audit, first finding expanded.
test("captures the workspace after the entry audit for the README", async ({}, testInfo) => {
  test.skip(!process.env.MAUXI_README_SCREENSHOT, "Set MAUXI_README_SCREENSHOT=1 to overwrite docs/images/mauxi-workspace.png");
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-readme-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html", "Local model");

  try {
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await expect(panel.getByRole("button", { name: "Re-run" })).toBeEnabled({ timeout: 120_000 });
    await expect(panel.locator(".finding-card").first()).toBeVisible();
    await expect(page.locator(".workspace-notice")).toHaveCount(0, { timeout: 15_000 });
    await panel.locator(".finding-card .finding-summary").first().click();
    await page.waitForTimeout(1_000);

    // Pan so the Desktop preview's left edge lines up with the width scope above it; the fit alone leaves them a zoom-dependent offset apart.
    const desktop = page.locator('.artboard[data-preview-id="desktop"]');
    const scope = (await page.locator(".width-scope").boundingBox())!;
    const board = (await desktop.boundingBox())!;
    await page.mouse.move(board.x + board.width / 2, board.y + board.height + 40);
    await page.mouse.wheel(board.x - scope.x, 0);
    await expect.poll(async () => Math.round((await desktop.boundingBox())!.x - scope.x)).toBe(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: output });
    await page.screenshot({ path: testInfo.outputPath("mauxi-workspace.png") });
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
