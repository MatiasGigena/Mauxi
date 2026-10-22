import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { entryAuditSettled } from "../helpers/entry-audit";
import { AUDIT_PROFILES, type AuditFinding, type AuditReport } from "../../src/application/audit-contract";

declare global { interface Window { lastAuditReport?: AuditReport | null } }

let application: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-interactions.html" } });
  page = await application.firstWindow();
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => { window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; }); });
  await entryAuditSettled(page);
});

test.afterAll(async () => { await application?.close(); });

const byTestId = (report: AuditReport, testId: string) => report.findings.filter((finding) => finding.element?.testId === testId);

function only(report: AuditReport, testId: string): AuditFinding {
  const matches = byTestId(report, testId);
  expect(matches, `findings for ${testId}`).toHaveLength(1);

  return matches[0];
}

test("audits keyboard focus, opened menus and hover content without activating navigating triggers", async ({}, testInfo) => {
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  await expect(mobile.locator('[data-testid="menu-toggle"]')).toBeVisible({ timeout: 30_000 });
  await mobile.locator("body").evaluate(() => { localStorage.removeItem("mauxi-fixture:navigated"); localStorage.removeItem("mauxi-fixture:filters"); });

  await page.evaluate(() => { window.lastAuditReport = null; });
  const panel = page.getByRole("complementary", { name: "Responsive audit" });
  await panel.getByRole("button", { name: "Re-run", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Checking keyboard focus and menus", { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 120_000 }).toBe(true);
  const report = await page.evaluate(() => window.lastAuditReport);

  if (!report) throw new Error("The audit report was not delivered.");
  await writeFile(testInfo.outputPath("interaction-report.json"), JSON.stringify({ ...report, snapshots: report.snapshots.map(({ image, ...snapshot }) => ({ ...snapshot, imageBytes: image.length })) }, null, 2));

  for (const snapshot of report.snapshots) await writeFile(testInfo.outputPath(`snapshot-${snapshot.profileId}.jpg`), Buffer.from(snapshot.image.split(",")[1], "base64"));

  // The pass ran at both narrow profiles, within its bounds, and the audited page never left its URL.
  expect(report.route).toBe("/audit-interactions.html");
  expect(report.url).toBe("http://127.0.0.1:45173/audit-interactions.html");
  const interactions = report.interactions!;
  expect(interactions.profiles).toEqual(["zoom-400", "phone-sm"]);
  expect(interactions.focusStops).toBeGreaterThanOrEqual(20);
  expect(interactions.focusStops).toBeLessThanOrEqual(80);
  expect(interactions.disclosures).toBe(10);
  expect(interactions.hovers).toBe(1);
  expect(interactions.durationMs).toBeLessThan(10_000);

  // 2.4.11: Tab focus lands on story links entirely hidden under the sticky header at 400% zoom. The static coverage
  // check measures the top of the page, where the header still sits below the promo strip, so only the walk finds it.
  const header = only(report, "ix-header");
  expect(header).toMatchObject({ kind: "focus-obscured", classification: "bug", severity: "serious", criterion: { id: "2.4.11" }, ranges: [[320, 320]], worst: { width: 320, height: 256 } });
  expect(header.detail).toMatch(/Keyboard focus walk: \d+ focus stops entirely hidden behind \[data-testid="ix-header"\] at 320×256 \(/);
  expect(header.detail).toContain('a "Read the story"');
  expect(header.detail).not.toContain('"Fieldnotes"');
  expect(header.markers.map((marker) => marker.profileId)).toEqual(["focus-zoom-400"]);
  expect(report.snapshots.find((snapshot) => snapshot.profileId === "focus-zoom-400")).toMatchObject({ width: 320, height: 256, imageHeight: 256 });
  expect(report.findings.filter((finding) => finding.kind === "sticky-obstruction")).toEqual([]);

  // 2.4.7: outline removed with no replacement.
  expect(only(report, "no-focus-style")).toMatchObject({ kind: "focus-not-visible", classification: "review", severity: "serious", criterion: { id: "2.4.7" }, title: "No visible focus indicator" });

  // 1.4.10 on opened content: the hamburger menu is 420px wide at 320px.
  const menu = only(report, "wide-menu");
  expect(menu).toMatchObject({ kind: "disclosure-overflow", classification: "bug", criterion: { id: "1.4.10" }, profiles: ["zoom-400", "phone-sm"], ranges: [[320, 320]] });
  // 420px past a 320px viewport, or 305px when the window shows a classic scrollbar.
  expect(menu.worst.overflowPx).toBeGreaterThanOrEqual(100);
  expect(menu.worst.overflowPx).toBeLessThanOrEqual(116);
  expect(menu.detail).toContain('Opened with button "Menu"');
  expect(menu.markers.map((marker) => marker.profileId)).toEqual(["menu-zoom-400", "menu-phone-sm"]);
  // The hut drawer scrolls, but its 100vh scrollport starts 64px down, so its bottom 64px never come into view.
  const drawer = only(report, "hut-drawer");
  expect(drawer).toMatchObject({ kind: "disclosure-overflow", classification: "bug", criterion: { id: "1.4.10" }, title: expect.stringContaining("cut off"), profiles: ["zoom-400", "phone-sm"], ranges: [[320, 320]], worst: { overflowPx: 64 } });
  expect(drawer.detail).toMatch(/^Opened nav "[^"]*" is position: fixed and its scroll area \[data-testid="hut-drawer"\] ends 64px below the \d+×256 viewport/);
  expect(drawer.detail).toContain('Opened with button "Huts"');
  // The trail sheet's list runs far below the viewport, but its own overflow-y: auto list scrolls it into reach.
  expect(report.findings.filter((finding) => finding.kind === "disclosure-overflow").map((finding) => finding.element?.testId)).toEqual(["wide-menu", "hut-drawer"]);

  // 1.4.13: hover tooltip clipped by the right edge at 320px.
  const tooltip = only(report, "tooltip-trigger");
  expect(tooltip).toMatchObject({ kind: "hover-content", classification: "bug", criterion: { id: "1.4.13" }, profiles: ["phone-sm"] });
  expect(tooltip.detail).toContain("past the right edge");

  // Negatives stay silent: a fitting <details>, a fixed sheet whose overflow scrolls in its own list, a visible unobscured
  // focus, a bottom bar matched by scroll-padding, and the triggers that would navigate.
  for (const negative of ["faq", "trail-sheet", "trails-toggle", "huts-toggle", "home-link", "navigating-trigger", "submit-trigger", "menu-toggle", "ix-bar", "filters-toggle", "filters-popup"]) expect(byTestId(report, negative), negative).toEqual([]);
  expect(interactions.notes).toEqual(expect.arrayContaining([
    expect.stringMatching(/^Not activated: button "Share" \(\[data-testid="navigating-trigger"\]\): its click handler navigates/),
    expect.stringMatching(/^Not activated: button "Sort" \(\[data-testid="submit-trigger"\]\): it submits a form/),
  ]));
  expect(interactions.notes.join("\n")).not.toMatch(/tried to change the page URL|Could not return|stopped/);
  expect(report.summary).toMatchObject({ bug: 4, review: 1, intentional: 0 });
  // axe-core ran at every width profile and the lab is clean for its rules, so the counts above are interaction findings only.
  expect(report.axe).toMatchObject({ profiles: AUDIT_PROFILES.filter((profile) => profile.axe).map((profile) => profile.id), note: null });
  expect(report.findings.filter((finding) => finding.kind === "axe")).toEqual([]);

  // The navigating triggers were never clicked: their handlers would have written to the shared session storage.
  expect(await mobile.locator("body").evaluate(() => localStorage.getItem("mauxi-fixture:navigated"))).toBeNull();
  // The filter popup has no aria-expanded and ignores a second click on its button. It was opened, and the pass saw it still
  // showing and closed it with Escape instead of trusting the unchanged (absent) aria-expanded and leaving it open.
  expect(await mobile.locator("body").evaluate(() => localStorage.getItem("mauxi-fixture:filters"))).toBe("closed");

  // The panel lists the interaction checks and the canvas shows the moment focus was hidden.
  await expect(panel.getByRole("region", { name: "Interaction checks" })).toContainText(`${interactions.focusStops} focus stops · 10 disclosures opened · 1 tooltip hovered · 400% zoom, Small phone`);
  await expect(page.locator('.snapshot-board[data-profile-id="focus-zoom-400"] .finding-marker')).toHaveCount(1);
  await expect(page.locator('.snapshot-board[data-profile-id="menu-zoom-400"] .finding-marker')).toHaveCount(1);
  await expect(page.locator('.snapshot-board[data-profile-id="hover-phone-sm"] .finding-marker')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("workspace-interactions.png") });

  // Expanded focus finding next to its snapshot board, for the artifact.
  await panel.locator(`.finding-card[data-finding-id="${header.id}"] .finding-summary`).click();
  await expect(panel.locator(`.finding-card[data-finding-id="${header.id}"]`)).toContainText("Keyboard focus walk");
  await page.screenshot({ path: testInfo.outputPath("workspace-focus-finding.png") });
});
