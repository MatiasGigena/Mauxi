import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { entryAuditSettled } from "../helpers/entry-audit";
import type { AuditReport } from "../../src/application/audit-contract";

declare global { interface Window { lastAuditReport?: AuditReport | null; mauxiKept?: boolean } }

let application: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-cards.html" } });
  page = await application.firstWindow();
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => { window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; }); });
  await entryAuditSettled(page);
});

test.afterAll(async () => { await application?.close(); });

test("a finding on the second of identical sibling cards resolves to and highlights that card", async ({}, testInfo) => {
  const panel = page.getByRole("complementary", { name: "Responsive audit" });
  // The canvas audited the page when it opened.
  await expect.poll(() => page.evaluate(() => !!window.lastAuditReport), { timeout: 150_000 }).toBe(true);
  const report = (await page.evaluate(() => window.lastAuditReport))!;
  const findings = report.findings.filter((finding) => finding.kind === "page-overflow");
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  expect(finding.ranges[0][0]).toBe(320);
  const selector = finding.element!.selector;
  expect(selector).toBe("body > main > article.card:nth-of-type(2) > p.card-body");

  // The selector names exactly the measured element, never the first card's identical body.
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  const matches = await mobile.locator("body").evaluate((_, value) => [...document.querySelectorAll(value)].map((element) => element.closest("article")?.getAttribute("data-card")), selector);
  expect(matches).toEqual(["2"]);

  // Show at keeps the mobile preview's document (already on the audited route) and outlines the second card's body.
  await mobile.locator("body").evaluate(() => { window.mauxiKept = true; });
  const card = panel.locator(`.finding-card[data-finding-id="${finding.id}"]`);
  await card.locator(".finding-summary").click();
  await card.getByRole("button", { name: "Show at 320px" }).click();
  await expect.poll(() => mobile.locator("body").evaluate(() => innerWidth)).toBe(320);
  const overlay = mobile.locator("[data-mauxi-overlay]", { hasText: finding.title });
  await expect(overlay).toBeVisible();
  expect(await mobile.locator("body").evaluate(() => window.mauxiKept)).toBe(true);

  const { box, target } = await overlay.evaluate((outline) => {
    const rect = (element: Element | null) => {
      const { x, y, width, height } = element!.getBoundingClientRect();

      return { x, y, width, height };
    };

    return { box: rect(outline), target: rect(document.querySelector('[data-card="2"] .card-body')) };
  });

  expect(Math.abs(box.x - (target.x - 3))).toBeLessThan(1.5);
  expect(Math.abs(box.y - (target.y - 3))).toBeLessThan(1.5);
  await page.screenshot({ path: testInfo.outputPath("selector-show-finding.png") });
  await writeFile(testInfo.outputPath("selector-finding.json"), JSON.stringify({ selector, matches, ranges: finding.ranges, overlay: box, target }, null, 2));
});
