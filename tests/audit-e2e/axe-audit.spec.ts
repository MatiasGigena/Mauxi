import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditFinding, AuditReport } from "../../src/application/audit-contract";

const LAB = path.resolve("fixtures/vite/src/audit-axe/AxeLab.tsx");
const HERO = '<img className="axe-photo" src={photo} width={640} height={360} data-testid="hero-photo" />';

// Eight unnamed images ahead of the photo fill axe-core's image-alt node list, so the photo is no longer listed.
const FILLER = '{Array.from({ length: 8 }, (_, index) => <img key={index} src={divider} width={8} height={8} data-testid="alt-filler" />)}';
const NAMED = HERO.replace("<img ", '<img alt="Two bikes by the harbor" ');
const TAGLINE = '<p className="axe-tagline" data-testid="mobile-tagline">';

// A "fix" that paints the tagline in its background color: axe-core cannot decide it (equalRatio), and that reason is ignored.
const PAINTED = TAGLINE.replace("<p ", '<p style={{ color: "#ffffff" }} ');

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

async function runAudit(): Promise<AuditReport> {
  await page.evaluate(() => { window.lastAuditReport = null; });
  await page.getByRole("complementary", { name: "Responsive audit" }).getByRole("button", { name: "Re-run", exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 120_000 }).toBe(true);
  const report = await page.evaluate(() => window.lastAuditReport);

  if (!report) throw new Error("The audit report was not delivered.");

  return report;
}

/** Writes the lab source and waits until the dev server serves it. */
async function writeLab(source: string, marker: string): Promise<void> {
  await writeFile(LAB, source);
  await expect.poll(() => fetch("http://127.0.0.1:45173/src/audit-axe/AxeLab.tsx").then((response) => response.text()), { timeout: 15_000 }).toContain(marker);
}

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
  const toggle = only(report, "mobile-menu-toggle");
  expect(toggle).toMatchObject({ kind: "axe", classification: "bug", severity: "serious", criterion: { id: "4.1.2" }, rule: { id: "button-name" }, ranges: [[320, 390]], profiles: ["phone-sm", "phone"], worst: { width: 320 } });
  expect(toggle.title).toContain("only at 320–390px");
  expect(toggle.detail).toContain("not at Tablet (768px), Laptop (1280px), Desktop (1440px)");
  expect(toggle.element?.source).toMatchObject({ file: "src/audit-axe/AxeLab.tsx", verified: true });
  expect(toggle.rule?.url).toMatch(/^https:\/\/dequeuniversity\.com\/rules\/axe\/4\.13\/button-name/);
  expect(toggle.markers.map((marker) => marker.profileId)).toEqual(["phone-sm", "phone"]);

  const tagline = only(report, "mobile-tagline");
  expect(tagline).toMatchObject({ kind: "axe", classification: "bug", criterion: { id: "1.4.3", name: "Contrast (Minimum)" }, rule: { id: "color-contrast" }, ranges: [[320, 390]] });
  expect(tagline.detail).toContain("insufficient color contrast");
  // Failing on phones and inconclusive on the wide gradient: the wide profiles are unknown, never reported as passing.
  const offer = only(report, "mixed-contrast");
  expect(offer).toMatchObject({ kind: "axe", classification: "bug", rule: { id: "color-contrast" }, ranges: [[320, 390]], profiles: ["phone-sm", "phone"] });
  expect(offer.title).not.toContain("only at");
  expect(offer.detail).toContain("Found at Small phone (320px), Phone (390px); inconclusive at Tablet (768px), Laptop (1280px), Desktop (1440px), where axe-core could not decide.");
  expect(offer.detail).not.toContain("not at");

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
  expect(report.summary).toMatchObject({ bug: 5, review: 1, intentional: 0 });

  // Panel and snapshot markers: the toggle is marked on the phone snapshots only.
  await expect(panel.locator(".audit-summary [data-kind=bug] dd")).toHaveText("5");
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

test("keeps a cut-off finding unverified across runs until a complete check resolves it", async ({}, testInfo) => {
  const original = await readFile(LAB, "utf8");
  expect(original).toContain(HERO);
  const baseline = await page.evaluate(() => window.lastAuditReport);
  const photo = baseline?.findings.find((finding) => finding.element?.testId === "hero-photo");

  if (!photo) throw new Error("The first test must report the hero photo.");
  const ids = (findings: AuditFinding[] | undefined) => (findings ?? []).map((finding) => finding.id);

  try {
    await writeLab(original.replace(HERO, `${FILLER}\n          ${HERO}`), "alt-filler");
    const cutOff = await runAudit();
    await writeFile(testInfo.outputPath("axe-cut-off.json"), JSON.stringify({ ...cutOff, snapshots: [] }, null, 2));
    expect(cutOff.findings.filter((finding) => finding.element?.testId === "alt-filler")).toHaveLength(8);
    expect(ids(cutOff.findings)).not.toContain(photo.id);
    expect(ids(cutOff.unverified)).toEqual([photo.id]);
    expect(ids(cutOff.resolved)).not.toContain(photo.id);

    // Still cut off: the photo stays unverified rather than being forgotten.
    const again = await runAudit();
    expect(ids(again.unverified)).toEqual([photo.id]);
    expect(ids(again.resolved)).toEqual([]);
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await panel.getByRole("button", { name: /Not re-checked this run/ }).click();
    await expect(panel.locator(".unverified-group li")).toHaveText([photo.title]);
    await page.screenshot({ path: testInfo.outputPath("axe-unverified.png") });

    // A complete image-alt check without the photo resolves it, together with the filler.
    await writeLab(original.replace(HERO, NAMED), "Two bikes by the harbor");
    const fixed = await runAudit();
    await writeFile(testInfo.outputPath("axe-resolved.json"), JSON.stringify({ ...fixed, snapshots: [] }, null, 2));
    expect(fixed.findings.filter((finding) => finding.rule?.id === "image-alt")).toEqual([]);
    expect(ids(fixed.resolved)).toEqual(expect.arrayContaining([photo.id]));
    expect(fixed.resolved.filter((finding) => finding.element?.testId === "alt-filler")).toHaveLength(8);
    expect(fixed.unverified ?? []).toEqual([]);
    await expect(panel.getByRole("button", { name: /Resolved since last run/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /Not re-checked this run/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("axe-resolved.png") });
  } finally { await writeFile(LAB, original); }
});

test("keeps a contrast finding unverified when axe-core's answer for its rule becomes an ignored inconclusive result", async ({}, testInfo) => {
  const original = await readFile(LAB, "utf8");
  expect(original).toContain(TAGLINE);
  const ids = (findings: AuditFinding[] | undefined) => (findings ?? []).map((finding) => finding.id);

  try {
    const baseline = await runAudit();
    const tagline = only(baseline, "mobile-tagline");

    await writeLab(original.replace(TAGLINE, PAINTED), "#ffffff");
    const painted = await runAudit();
    await writeFile(testInfo.outputPath("axe-ignored.json"), JSON.stringify({ ...painted, snapshots: [] }, null, 2));
    // Ignored reasons never become findings: the tagline is simply no longer listed, and nothing else changes.
    expect(painted.findings.filter((finding) => finding.element?.testId === "mobile-tagline")).toEqual([]);
    expect(ids(painted.findings)).toEqual(ids(baseline.findings).filter((id) => id !== tagline.id));
    expect(painted.axe?.note).toBeNull();
    // Not decided is not passing: the tagline is carried forward instead of resolved.
    expect(ids(painted.unverified)).toEqual([tagline.id]);
    expect(ids(painted.resolved)).toEqual([]);

    // The real contrast problem comes back with the same id, and nothing is left unverified.
    await writeFile(LAB, original);
    await expect.poll(() => fetch("http://127.0.0.1:45173/src/audit-axe/AxeLab.tsx").then((response) => response.text()), { timeout: 15_000 }).not.toContain("#ffffff");
    const restored = await runAudit();
    expect(only(restored, "mobile-tagline").id).toBe(tagline.id);
    expect(restored.unverified ?? []).toEqual([]);
  } finally { await writeFile(LAB, original); }
});
