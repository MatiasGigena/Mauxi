import { expect, type Page } from "@playwright/test";

/** The canvas audits its start page as soon as it opens and opens the panel itself; resolves once that run has finished. */
export async function entryAuditSettled(page: Page, timeout = 150_000): Promise<void> {
  await expect(page.getByRole("complementary", { name: "Responsive audit" }).getByRole("button", { name: "Re-run", exact: true })).toBeVisible({ timeout });
}
