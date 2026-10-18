import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditFinding, AuditReport } from "../../src/application/audit-contract";

const LAB_CSS = path.resolve("fixtures/next/app/audit-lab/audit-lab.module.css");
const PLANTED = "width: 600px; /* planted: fixed width */";
const FIXED = "max-width: 600px; flex-wrap: wrap;";
const PLANTED_IDS = ["pricing-table", "tracking-link", "feature-grid", "promo-card", "lab-header", "icon-search", "icon-account", "icon-cart", "filter-row", "partner-rail"];
const NEGATIVE_IDS = ["origin-carousel", "price-table", "offcanvas-drawer", "sr-only-text", "cookie-bar"];

declare global { interface Window { lastAuditReport?: AuditReport | null } }

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

/** The Next.js App Router audit lab, shared by the Webpack (audit suite) and Turbopack (turbopack suite) runs. */
export function describeNextAuditLab(fixture: "next" | "next-turbopack"): void {
  let application: ElectronApplication;
  let page: Page;

  async function runAudit(label: "Run audit" | "Re-run"): Promise<AuditReport> {
    await page.evaluate(() => { window.lastAuditReport = null; });
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await panel.getByRole("button", { name: label, exact: true }).click();
    await expect(panel.getByRole("status")).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 150_000 }).toBe(true);
    const report = await page.evaluate(() => window.lastAuditReport);

    if (!report) throw new Error("The audit report was not delivered.");

    return report;
  }

  test.describe(`Next.js audit lab (${fixture === "next" ? "Webpack" : "Turbopack"})`, () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test.beforeAll(async ({}, testInfo) => {
      application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: `http://127.0.0.1:44173/?fixture=${fixture}&path=/audit-lab` } });
      page = await application.firstWindow();
      await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 90_000 });
      await page.evaluate(() => { window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; }); });
      await page.getByRole("button", { name: "Responsive audit", exact: true }).click();
    });

    test.afterAll(async () => { await application?.close(); });

    test("finds the planted problems on a Next dev route and keeps the negatives silent", async ({}, testInfo) => {
      const report = await runAudit("Run audit");
      await saveArtifacts(report, "next-audit-initial", (file) => testInfo.outputPath(file));

      expect(report.route).toBe("/audit-lab");
      expect(report.widthsScanned).toBeGreaterThanOrEqual(70);
      expect(report.snapshots.map((snapshot) => snapshot.profileId)).toEqual(["phone-sm", "phone", "tablet", "laptop", "desktop", "zoom-400", "text-spacing"]);

      // Planted bugs. The pricing row lives in a client component; its source is host-verified by the literal test ID.
      const pricing = only(report, "pricing-table");
      expect(pricing).toMatchObject({ kind: "page-overflow", classification: "bug", severity: "serious", criterion: { id: "1.4.10" } });
      expect(pricing.ranges[0][0]).toBe(320);
      expect(pricing.ranges[0][1]).toBeGreaterThanOrEqual(592);
      expect(pricing.ranges[0][1]).toBeLessThan(672);
      expect(pricing.element?.source).toMatchObject({ file: "app/audit-lab/PricingTable.tsx", verified: true, component: "PricingTable" });
      expect(pricing.element?.source?.line).toBeGreaterThan(0);

      const tracking = only(report, "tracking-link");
      expect(tracking).toMatchObject({ kind: "page-overflow", classification: "bug", criterion: { id: "1.4.10" } });
      expect(tracking.element?.source).toMatchObject({ file: "app/audit-lab/page.tsx", verified: true });

      const grid = only(report, "feature-grid");
      expect(grid).toMatchObject({ kind: "page-overflow", classification: "bug", criterion: null });
      expect(grid.ranges).toEqual([[800, 960]]);

      expect(only(report, "promo-card")).toMatchObject({ kind: "text-spacing-clipped", classification: "bug", criterion: { id: "1.4.12" } });
      expect(only(report, "lab-header")).toMatchObject({ kind: "sticky-obstruction", criterion: { id: "2.4.11" }, worst: { width: 320, height: 256 } });
      const zoom = report.findings.find((finding) => finding.kind === "zoom-blocked");
      expect(zoom).toMatchObject({ criterion: { id: "1.4.4" }, classification: "bug" });
      expect(zoom?.detail).toContain("maximum-scale=1");

      for (const icon of ["icon-search", "icon-account", "icon-cart"]) expect(only(report, icon)).toMatchObject({ kind: "target-size", criterion: { id: "2.5.8" } });

      expect(only(report, "filter-row")).toMatchObject({ kind: "scroller-review", classification: "review" });
      expect(only(report, "partner-rail")).toMatchObject({ kind: "scroller-a11y", classification: "intentional", criterion: { id: "2.1.1" } });
      expect(report.scrollers.map((scroller) => scroller.element.testId)).toEqual(expect.arrayContaining(["origin-carousel", "price-table", "partner-rail"]));

      // Inherited from the shared root layout: body { min-width: 320px } overflows by the scrollbar at 320px. It has no test ID,
      // so its source is the unverified hint from the Server Component stack (RootLayout); Turbopack only exposes server chunks.
      const scrollbar = report.findings.filter((finding) => finding.kind === "page-overflow" && finding.element?.tag === "body");
      expect(scrollbar).toHaveLength(1);
      expect(scrollbar[0]).toMatchObject({ classification: "bug", criterion: { id: "1.4.10" }, ranges: [[320, 320]] });
      expect(scrollbar[0].detail).toContain("scrollbar");
      expect(scrollbar[0].element?.source).toEqual({ component: "RootLayout", file: fixture === "next" ? "app/layout.tsx" : null, line: null });

      // Negatives and Next's own dev UI (dev overlay portal, route announcer) stay silent.
      for (const negative of NEGATIVE_IDS) expect(byTestId(report, negative)).toEqual([]);
      const unexpected = report.findings.filter((finding) => finding.element && finding.element.tag !== "body" && !PLANTED_IDS.includes(finding.element.testId ?? ""));
      expect(unexpected.map((finding) => `${finding.kind} ${finding.element?.selector}`)).toEqual([]);
      expect(report.summary).toMatchObject({ bug: 10, review: 1, intentional: 1 });

      // Hints name the component that wrote the JSX (never Next internals) and project files (never bundler chunks).
      for (const finding of report.findings) {
        const source = finding.element?.source;

        if (source?.file) expect(source.file, finding.id).toMatch(/^app\/(?:layout|audit-lab\/(?:page|PricingTable))\.tsx$/);

        if (finding.element) expect(source?.component, finding.id).toMatch(/^(?:RootLayout|AuditLabPage|PricingTable)$/);
      }

      const panel = page.getByRole("complementary", { name: "Responsive audit" });
      await expect(panel.locator(".audit-summary [data-kind=bug] dd")).toHaveText("10");
      await expect(page.locator(".snapshot-board")).toHaveCount(7);
      await expect(page.locator('.snapshot-board[data-profile-id="zoom-400"] .finding-marker')).not.toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("next-workspace-matrix.png") });

      const card = panel.locator(`.finding-card[data-finding-id="${pricing.id}"]`);
      await card.locator(".finding-summary").click();
      await card.getByRole("button", { name: "Show at 320px" }).click();
      const mobile = page.frameLocator('[data-testid="mobile-preview"]');
      await expect.poll(() => mobile.locator("body").evaluate(() => innerWidth)).toBe(320);
      await expect(mobile.locator("[data-mauxi-overlay]", { hasText: pricing.title })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("next-show-finding.png") });
    });

    test("re-running after a CSS module fix picks up the hot-reloaded source", async ({}, testInfo) => {
      const original = await readFile(LAB_CSS, "utf8");
      expect(original).toContain(PLANTED);

      try {
        await writeFile(LAB_CSS, original.replace(PLANTED, FIXED));
        // Wait for the dev server to hot-reload the CSS module into the preview, as a person would before re-running.
        const desktop = page.frameLocator('[data-testid="desktop-preview"]').locator('[data-testid="pricing-table"]');
        await expect.poll(() => desktop.evaluate((element) => getComputedStyle(element).flexWrap), { timeout: 60_000 }).toBe("wrap");
        const report = await runAudit("Re-run");
        await saveArtifacts(report, "next-audit-after-fix", (file) => testInfo.outputPath(file));

        expect(byTestId(report, "pricing-table")).toEqual([]);
        expect(report.resolved.map((finding) => finding.element?.testId)).toContain("pricing-table");
        expect(report.findings.map((finding) => finding.element?.testId)).toEqual(expect.arrayContaining(["tracking-link", "feature-grid", "promo-card"]));
        await expect(page.getByRole("button", { name: /Resolved since last run/ })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("next-resolved.png") });
      } finally { await writeFile(LAB_CSS, original); }
    });
  });
}
