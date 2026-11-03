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
    await page.screenshot({ path: output });
    await page.screenshot({ path: testInfo.outputPath("mauxi-workspace.png") });
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
