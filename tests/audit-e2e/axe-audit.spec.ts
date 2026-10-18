import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditFinding, AuditReport } from "../../src/application/audit-contract";

declare global { interface Window { lastAuditReport?: AuditReport | null } }

let application: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-axe.html" } });
  page = await application.firstWindow();
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => { window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; }); });
  await page.getByRole("button", { name: "Responsive audit", exact: true }).click();
});

test.afterAll(async () => { await application?.close(); });

function only(report: AuditReport, testId: string): AuditFinding {
  const matches = report.findings.filter((finding) => finding.element?.testId === testId);
  expect(matches, `findings for ${testId}`).toHaveLength(1);

  return matches[0];
}

test("runs axe-core at every width profile and reports layout-specific violations with their width ranges", async ({}, testInfo) => {
  const panel = page.getByRole("complementary", { name: "Responsive audit" });
  await panel.getByRole("button", { name: "Run audit", exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 120_000 }).toBe(true);
  const report = await page.evaluate(() => window.lastAuditReport);

  if (!report) throw new Error("The audit report was not delivered.");
  await writeFile(testInfo.outputPath("axe-report.json"), JSON.stringify({ ...report, snapshots: report.snapshots.map(({ image, ...snapshot }) => ({ ...snapshot, imageBytes: image.length })) }, null, 2));

  expect(report.route).toBe("/audit-axe.html");
  expect(report.axe).toMatchObject({ version: "4.13.0", profiles: ["phone-sm", "phone", "tablet", "laptop", "desktop"], note: null });
  expect(report.durationMs).toBeLessThan(30_000);

  // Mobile-only problems: present at 320 and 390px, gone from the tablet layout up.
  const toggle = only(report, "menu-toggle");
  expect(toggle).toMatchObject({ kind: "axe", classification: "bug", severity: "serious", criterion: { id: "4.1.2" }, rule: { id: "button-name" }, ranges: [[320, 390]], profiles: ["phone-sm", "phone"], worst: { width: 320 } });
  expect(toggle.title).toContain("only at 320–390px");
  expect(toggle.detail).toContain("not at Tablet (768px), Laptop (1280px), Desktop (1440px)");
  expect(toggle.element?.source).toMatchObject({ file: "src/audit-axe/AxeLab.tsx", verified: true });
  expect(toggle.rule?.url).toMatch(/^https:\/\/dequeuniversity\.com\/rules\/axe\/4\.13\/button-name/);
  expect(toggle.markers.map((marker) => marker.profileId)).toEqual(["phone-sm", "phone"]);

  const tagline = only(report, "mobile-tagline");
  expect(tagline).toMatchObject({ kind: "axe", classification: "bug", criterion: { id: "1.4.3", name: "Contrast (Minimum)" }, rule: { id: "color-contrast" }, ranges: [[320, 390]] });
  expect(tagline.detail).toContain("insufficient color contrast");

  // Wide-only and every-width problems.
  expect(only(report, "social-link")).toMatchObject({ kind: "axe", classification: "bug", rule: { id: "link-name" }, ranges: [[1280, 1440]], profiles: ["laptop", "desktop"] });
  const photo = only(report, "hero-photo");
  expect(photo).toMatchObject({ kind: "axe", classification: "bug", criterion: { id: "1.1.1" }, rule: { id: "image-alt" }, ranges: [[320, 1440]] });
  expect(photo.title).not.toContain("only at");

  // Inconclusive contrast on a gradient is left for a person to review.
  expect(only(report, "gradient-banner")).toMatchObject({ kind: "axe", classification: "review", rule: { id: "color-contrast" } });

  // Deliberate negatives stay silent, and axe never repeats a check Mauxi measures itself.
  for (const negative of ["search-toggle", "decorative-divider", "large-text", "sold-out", "hidden-drawer"]) expect(report.findings.filter((finding) => finding.element?.testId === negative), negative).toEqual([]);
  expect(report.findings.filter((finding) => ["target-size", "meta-viewport", "meta-viewport-large", "scrollable-region-focusable"].includes(finding.rule?.id ?? ""))).toEqual([]);
  expect(report.summary).toMatchObject({ bug: 4, review: 1, intentional: 0 });

  // Panel and snapshot markers: the toggle is marked on the phone snapshots only.
  await expect(panel.locator(".audit-summary [data-kind=bug] dd")).toHaveText("4");
  await expect(panel.getByRole("note")).toHaveCount(0);
  const card = panel.locator(`.finding-card[data-finding-id="${toggle.id}"]`);
  await expect(card.locator(".finding-rule")).toHaveText("axe · button-name");
  await card.locator(".finding-summary").click();
  await expect(card.getByRole("button", { name: "Learn more" })).toBeVisible();
  const markerName = `Finding ${report.findings.indexOf(toggle) + 1}: ${toggle.title}`;
  await expect(page.locator('.snapshot-board[data-profile-id="phone-sm"]').getByRole("button", { name: markerName })).toBeVisible();
  await expect(page.locator('.snapshot-board[data-profile-id="desktop"]').getByRole("button", { name: markerName })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("axe-workspace.png") });

  // Only Deque rule pages linked from a report can be opened outside Mauxi.
  await expect(page.evaluate(() => window.mauxi!.openAxeHelp("https://example.com/rules/axe/4.13/button-name"))).rejects.toThrow(/Unapproved help URL/);
  await expect(page.evaluate(() => window.mauxi!.openAxeHelp("https://dequeuniversity.com/rules/axe/4.13/not-in-the-report"))).rejects.toThrow(/Unapproved help URL/);
});
