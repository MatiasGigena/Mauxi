import { expect, type Page } from "@playwright/test";

/** The canvas audits its start page as soon as it opens and opens the panel itself; resolves once that run has finished. */
export async function entryAuditSettled(page: Page, timeout = 150_000): Promise<void> {
  await expect(page.getByRole("complementary", { name: "Responsive audit" }).getByRole("button", { name: "Re-run", exact: true })).toBeVisible({ timeout });
}

/** The canvas opens on the live previews; once the entry audit is done, the offer under the top bar puts its snapshots on the canvas. */
export async function showSnapshots(page: Page, timeout = 15_000): Promise<void> {
  const offer = page.getByRole("status", { name: "Audit snapshots ready" });
  await offer.getByRole("button", { name: "Show snapshots" }).click({ timeout });
  await expect(offer).toHaveCount(0);
  // The tiles' entrance and the camera's pull-back are over: what a test measures next is the settled sheet.
  await expect(page.locator('[data-testid="canvas"][data-sheet-entering]')).toHaveCount(0, { timeout });
  let last = "";
  await expect.poll(async () => { const now = await page.locator('[aria-label="Camera zoom"]').inputValue(); const same = now === last; last = now;

    return same; }, { intervals: [150], timeout }).toBe(true);
}
