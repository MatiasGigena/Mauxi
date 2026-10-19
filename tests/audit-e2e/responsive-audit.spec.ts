import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditFinding, AuditReport } from "../../src/application/audit-contract";

const LAB_CSS = path.resolve("fixtures/vite/src/audit-lab/audit-lab.css");
const PLANTED = "width: 600px; /* planted: fixed width */";
const FIXED = "max-width: 600px; flex-wrap: wrap;";
const LAB = path.resolve("fixtures/vite/src/audit-lab/AuditLab.tsx");
const MAIN = "      <main>\n";

// 6,000 empty elements at the top of <main> exhaust the 6,000-element scan limit before the pricing table is reached.
const FILLER = '        <div data-testid="scan-filler">{Array.from({ length: 6_000 }, (_, index) => <span key={index} />)}</div>\n';

declare global { interface Window { lastAuditReport?: AuditReport | null } }

let application: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-lab.html" } });
  page = await application.firstWindow();
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => { window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; }); });
  await page.getByRole("button", { name: "Responsive audit", exact: true }).click();
});

test.afterAll(async () => { await application?.close(); });

async function runAudit(label: "Run audit" | "Re-run"): Promise<AuditReport> {
  await page.evaluate(() => { window.lastAuditReport = null; });
  await page.getByRole("complementary", { name: "Responsive audit" }).getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Responsive audit" }).getByRole("status")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 120_000 }).toBe(true);
  const report = await page.evaluate(() => window.lastAuditReport);

  if (!report) throw new Error("The audit report was not delivered.");

  return report;
}

const byTestId = (report: AuditReport, testId: string) => report.findings.filter((finding) => finding.element?.testId === testId);

function only(report: AuditReport, testId: string): AuditFinding {
  const matches = byTestId(report, testId);
  expect(matches, `findings for ${testId}`).toHaveLength(1);

  return matches[0];
}

async function saveArtifacts(report: AuditReport, name: string, outputPath: (file: string) => string): Promise<void> {
  await writeFile(outputPath(`${name}.json`), JSON.stringify({ ...report, snapshots: report.snapshots.map(({ image, ...snapshot }) => ({ ...snapshot, imageBytes: image.length })) }, null, 2));

  for (const snapshot of report.snapshots) await writeFile(outputPath(`${name}-${snapshot.profileId}.jpg`), Buffer.from(snapshot.image.split(",")[1], "base64"));
}

test("audits the lab page across the width matrix, separating bugs from intentional scrollers", async ({}, testInfo) => {
  const report = await runAudit("Run audit");
  await saveArtifacts(report, "audit-initial", (file) => testInfo.outputPath(file));

  expect(report.route).toBe("/audit-lab.html");
  expect(report.widthsScanned).toBeGreaterThanOrEqual(70);
  expect(report.snapshots.map((snapshot) => snapshot.profileId)).toEqual(["phone-sm", "phone", "tablet", "laptop", "desktop", "zoom-400", "text-spacing"]);

  // Planted bugs, each attributed to its element with a host-verified source file.
  const pricing = only(report, "pricing-table");
  expect(pricing).toMatchObject({ kind: "page-overflow", classification: "bug", severity: "serious", criterion: { id: "1.4.10" } });
  expect(pricing.ranges[0][0]).toBe(320);
  expect(pricing.ranges[0][1]).toBeGreaterThanOrEqual(592);
  expect(pricing.ranges[0][1]).toBeLessThan(672);
  expect(pricing.element?.source).toMatchObject({ file: "src/audit-lab/PricingTable.tsx", verified: true });

  expect(only(report, "tracking-link")).toMatchObject({ kind: "page-overflow", classification: "bug", criterion: { id: "1.4.10" } });

  const grid = only(report, "feature-grid");
  expect(grid).toMatchObject({ kind: "page-overflow", classification: "bug", criterion: null });
  expect(grid.ranges).toEqual([[800, 960]]);

  expect(only(report, "promo-card")).toMatchObject({ kind: "text-spacing-clipped", classification: "bug", criterion: { id: "1.4.12" } });
  // The keyboard focus walk confirms the coverage finding on the same finding rather than adding one per bar.
  const header = only(report, "lab-header");
  expect(header).toMatchObject({ kind: "sticky-obstruction", criterion: { id: "2.4.11" }, worst: { width: 320, height: 256 } });
  expect(header.detail).toMatch(/Keyboard focus walk: \d+ focus stops? entirely hidden behind \[data-testid="lab-header"\] at 320×256/);
  expect(report.findings.filter((finding) => finding.kind === "focus-obscured")).toEqual([]);
  expect(report.findings.some((finding) => finding.kind === "zoom-blocked" && finding.criterion?.id === "1.4.4")).toBe(true);

  for (const icon of ["icon-search", "icon-account", "icon-cart"]) expect(only(report, icon)).toMatchObject({ kind: "target-size", criterion: { id: "2.5.8" } });

  // Scrollers: accidental one reviewed, intentional ones kept, inaccessible intentional one flagged.
  expect(only(report, "filter-row")).toMatchObject({ kind: "scroller-review", classification: "review" });
  // The rail is focusable only at the short 400% zoom viewport, measured last; every other profile still fails.
  const rail = only(report, "partner-rail");
  expect(rail).toMatchObject({ kind: "scroller-a11y", classification: "intentional", criterion: { id: "2.1.1" } });
  expect(rail.profiles).toEqual(expect.arrayContaining(["phone-sm", "phone"]));
  expect(rail.profiles).not.toContain("zoom-400");
  expect(rail.markers.map((marker) => marker.profileId)).not.toContain("zoom-400");
  // Its descendants are links and controls, but none can be tabbed to at phone widths; at tablet width and up "All stockists" can.
  const stockists = only(report, "stockist-rail");
  expect(stockists).toMatchObject({ kind: "scroller-a11y", classification: "intentional", criterion: { id: "2.1.1" } });
  expect(stockists.profiles).toEqual(expect.arrayContaining(["phone-sm", "phone"]));
  expect(stockists.profiles).not.toContain("tablet");
  const scrollers = report.scrollers.map((scroller) => scroller.element.testId);
  expect(scrollers).toEqual(expect.arrayContaining(["origin-carousel", "price-table", "partner-rail", "stockist-rail"]));

  // Deliberate negatives must stay silent.
  for (const negative of ["origin-carousel", "price-table", "offcanvas-drawer"]) expect(byTestId(report, negative)).toEqual([]);
  expect(report.findings.some((finding) => finding.element?.selector.includes("sr-only"))).toBe(false);
  expect(report.summary).toMatchObject({ bug: 9, review: 1, intentional: 2 });
  // axe-core ran at every width profile and the lab is clean for its rules, so the counts above are layout findings only.
  expect(report.axe).toMatchObject({ profiles: ["phone-sm", "phone", "tablet", "laptop", "desktop"], note: null });
  expect(report.findings.filter((finding) => finding.kind === "axe")).toEqual([]);

  // The panel and canvas reflect the report.
  const panel = page.getByRole("complementary", { name: "Responsive audit" });
  await expect(panel.locator(".audit-summary [data-kind=bug] dd")).toHaveText("9");
  await expect(page.locator(".snapshot-board")).toHaveCount(7);
  await expect(page.locator('.snapshot-board[data-profile-id="zoom-400"] .finding-marker')).not.toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("workspace-matrix.png") });

  // Show at the worst width: the live mobile preview is resized and the element outlined.
  const card = panel.locator(`.finding-card[data-finding-id="${pricing.id}"]`);
  await card.locator(".finding-summary").click();
  await card.getByRole("button", { name: "Show at 320px" }).click();
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  await expect.poll(() => mobile.locator("body").evaluate(() => innerWidth)).toBe(320);
  await expect(mobile.locator("[data-mauxi-overlay]", { hasText: pricing.title })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("show-finding.png") });

  // Fix with agent attaches the finding to the chat composer.
  await card.getByRole("button", { name: "Fix with agent" }).click();
  await expect(page.getByRole("list", { name: "Attached findings" }).getByRole("listitem")).toHaveText([pricing.title]);
  await expect(card.getByRole("button", { name: "Attached to chat" })).toBeDisabled();
});

test("a truncated scan keeps the finding unverified; re-running after a source fix resolves it", async ({}, testInfo) => {
  const original = await readFile(LAB_CSS, "utf8");
  const lab = await readFile(LAB, "utf8");
  expect(original).toContain(PLANTED);
  expect(lab).toContain(MAIN);
  const testIds = (findings: AuditFinding[] | undefined) => (findings ?? []).map((finding) => finding.element?.testId);
  const served = () => expect.poll(() => fetch("http://127.0.0.1:45173/src/audit-lab/AuditLab.tsx").then((response) => response.text()), { timeout: 15_000 });

  try {
    // The table still overflows but is past the element limit: absence from a truncated scan is not a fix.
    await writeFile(LAB, lab.replace(MAIN, MAIN + FILLER));
    await served().toContain("scan-filler");
    const truncated = await runAudit("Re-run");
    await saveArtifacts(truncated, "audit-truncated", (file) => testInfo.outputPath(file));
    expect(byTestId(truncated, "pricing-table")).toEqual([]);
    expect(testIds(truncated.resolved)).not.toContain("pricing-table");
    expect(testIds(truncated.unverified)).toContain("pricing-table");
    await page.getByRole("button", { name: /Not re-checked this run/ }).click();
    const pricing = truncated.unverified!.find((finding) => finding.element?.testId === "pricing-table")!;
    await expect(page.locator(".unverified-group li").filter({ hasText: pricing.title })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("unverified-truncated.png") });

    await writeFile(LAB, lab);
    await served().not.toContain("scan-filler");
    await writeFile(LAB_CSS, original.replace(PLANTED, FIXED));
    const report = await runAudit("Re-run");
    await saveArtifacts(report, "audit-after-fix", (file) => testInfo.outputPath(file));

    expect(byTestId(report, "pricing-table")).toEqual([]);
    expect(testIds(report.resolved)).toContain("pricing-table");
    expect(testIds(report.unverified)).not.toContain("pricing-table");
    expect(report.findings.map((finding) => finding.element?.testId)).toEqual(expect.arrayContaining(["tracking-link", "feature-grid", "promo-card"]));
    await expect(page.getByRole("button", { name: /Resolved since last run/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Attached findings" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("resolved.png") });
  } finally { await writeFile(LAB_CSS, original); await writeFile(LAB, lab); }
});
