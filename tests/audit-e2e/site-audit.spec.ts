import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuditSiteReport } from "../../src/application/audit-contract";

declare global { interface Window { lastSiteReport?: AuditSiteReport | null } }

const LAB = "/audit-lab.html";
const ABOUT = "/audit-lab-about.html";
const BLOG = "/audit-lab-blog.html";
const MEMBERS = "/audit-lab-members.html";
const ACCOUNT = "/audit-lab-account.html";
const EXCLUDED = "Auth, API, action or credential route";
const SignOutCounter = Type.Object({ signOuts: Type.Integer() });

let application: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: `http://127.0.0.1:44173/?fixture=vite&path=${LAB}` } });
  page = await application.firstWindow();
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
  await page.evaluate(() => { window.mauxi!.onAuditSite((report) => { window.lastSiteReport = report; }); });
  await page.getByRole("button", { name: "Responsive audit", exact: true }).click();
});

test.afterAll(async () => { await application?.close(); });

const panel = () => page.getByRole("complementary", { name: "Responsive audit" });

async function discover(): Promise<string[]> {
  await panel().getByRole("button", { name: "Audit site", exact: true }).click();
  const routes = panel().getByRole("list", { name: "Pages to audit" });
  await expect(routes.getByRole("checkbox")).toHaveCount(3, { timeout: 60_000 });

  return routes.locator("code").allTextContents();
}

async function siteReport(state: AuditSiteReport["state"]): Promise<AuditSiteReport> {
  await expect.poll(() => page.evaluate(() => window.lastSiteReport?.state), { timeout: 200_000 }).toBe(state);
  const report = await page.evaluate(() => window.lastSiteReport);

  if (!report) throw new Error("The site report was not delivered.");

  return report;
}

test("discovers linked pages, skips unsafe links, audits them in a batch and opens one page", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const routes = await discover();

  // Two levels: the about page is linked from the lab, the blog only from the about page. Hash links collapse.
  expect(routes).toEqual([LAB, ABOUT, BLOG]);
  const listed = panel().getByRole("list", { name: "Pages to audit" });
  await expect(listed.getByRole("listitem").filter({ hasText: BLOG })).toContainText(`Linked from ${ABOUT}`);
  await expect(listed.getByRole("checkbox")).toHaveCount(3);

  await panel().getByText("Skipped links").click();
  const skipped = await panel().getByRole("list", { name: "Skipped links" }).getByRole("listitem").evaluateAll((items) => items.map((item) => ({ route: item.querySelector("code")?.textContent ?? "", reason: item.querySelector("span")?.textContent ?? "" })));
  expect(skipped).toEqual(expect.arrayContaining([
    { route: "/api/logout", reason: "Auth, API, action or credential route" },
    { route: "/auth/callback?code=demo", reason: "Auth, API, action or credential route" },
    { route: "/audit-lab-menu.pdf", reason: "Download link" },
  ]));

  // Hand-added routes go through the same policy.
  await panel().getByRole("textbox", { name: "Add a route" }).fill("/api/orders");
  await panel().getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel().locator(".site-field-error")).toHaveText("Not added (Auth, API, action or credential route).");
  await expect(listed.getByRole("checkbox")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("site-setup.png") });

  await page.evaluate(() => { window.lastSiteReport = null; });
  await panel().getByRole("button", { name: "Audit 3 pages", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText(/Page [1-3] of 3/, { timeout: 30_000 });
  const site = await siteReport("done");

  expect(site.pages.map((item) => [item.route, item.status])).toEqual([[LAB, "done"], [ABOUT, "done"], [BLOG, "done"]]);
  const byRoute = new Map(site.pages.map((item) => [item.route, item]));
  // The lab keeps exactly the counts of a single-route audit.
  expect(byRoute.get(LAB)?.summary).toMatchObject({ bug: 9, review: 1, intentional: 2 });
  expect(byRoute.get(ABOUT)?.summary).toMatchObject({ bug: 0, review: 0, intentional: 0 });
  expect(byRoute.get(BLOG)?.summary).toMatchObject({ bug: 1, review: 0, intentional: 0 });
  expect(byRoute.get(BLOG)?.bugRanges[0][0]).toBe(320);

  const rows = panel().getByRole("list", { name: "Audited pages" });
  await expect(rows.locator(`[data-route="${LAB}"] [data-kind=bug]`)).toHaveText("9 bugs");
  await expect(rows.locator(`[data-route="${ABOUT}"] .site-page-widths`)).toHaveText("No bugs at any width");
  await expect(rows.locator(`[data-route="${BLOG}"] [data-kind=bug]`)).toHaveText("1 bug");
  await expect(rows.locator(`[data-route="${BLOG}"] .site-page-widths`)).toContainText("Bugs at 320");
  await expect(panel().locator(".audit-summary [data-kind=bug] dd")).toHaveText("10");
  await page.screenshot({ path: testInfo.outputPath("site-summary.png") });

  // Opening a page shows its findings and snapshots with the existing panel and boards.
  await rows.getByRole("button", { name: `Open ${BLOG}` }).click();
  await expect(panel().locator(".audit-panel-header code")).toHaveText(BLOG);
  await expect(panel().getByText("Page 3 of 3")).toBeVisible();
  await expect(panel().locator(".audit-summary [data-kind=bug] dd")).toHaveText("1");
  const card = panel().locator(".finding-card");
  await expect(card).toHaveCount(1);
  await card.locator(".finding-summary").click();
  await expect(card.locator(".finding-element code")).toHaveText('[data-testid="blog-banner"]');
  await expect(page.locator(".snapshot-board")).toHaveCount(7);
  await expect(page.locator('.snapshot-board[data-profile-id="phone-sm"] .finding-marker')).toHaveCount(1);
  // Batch snapshots are kept at half resolution to bound memory.
  await expect.poll(() => page.locator('.snapshot-board[data-profile-id="phone-sm"] img').evaluate((image) => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBe(160);
  await page.screenshot({ path: testInfo.outputPath("site-page.png") });

  // The previews still show the lab; Show at opens the blog in the mobile preview before outlining its banner.
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  await expect.poll(() => mobile.locator("body").evaluate(() => location.pathname)).toBe(LAB);
  await card.getByRole("button", { name: "Show at 320px" }).click();
  await expect.poll(() => mobile.locator("body").evaluate(() => location.pathname), { timeout: 30_000 }).toBe(BLOG);
  const overlay = mobile.locator("[data-mauxi-overlay]", { hasText: (await card.locator(".finding-summary strong").textContent())! });
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  expect(await mobile.locator("body").evaluate(() => innerWidth)).toBe(320);

  const outlined = await overlay.evaluate((box) => {
    const outline = box.getBoundingClientRect();
    const banner = document.querySelector('[data-testid="blog-banner"]')!.getBoundingClientRect();

    return { dx: outline.x - banner.x, dy: outline.y - banner.y };
  });

  expect(outlined.dx).toBeCloseTo(-3, 0);
  expect(outlined.dy).toBeCloseTo(-3, 0);
  await page.screenshot({ path: testInfo.outputPath("site-show-finding.png") });

  await panel().getByRole("button", { name: "All pages" }).click();
  await expect(rows).toBeVisible();

  const summary = { routes, skipped, pages: site.pages.map(({ route, status, summary: counts, bugRanges, resolved }) => ({ route, status, summary: counts, bugRanges, resolved })) };
  await writeFile(testInfo.outputPath("site-summary.json"), JSON.stringify(summary, null, 2));
});

test("Stop ends a site audit and skips the remaining pages", async ({}, testInfo) => {
  test.setTimeout(240_000);
  await discover();
  await page.evaluate(() => { window.lastSiteReport = null; });
  await panel().getByRole("button", { name: "Audit 3 pages", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("Page 1 of 3", { timeout: 30_000 });
  await panel().getByRole("button", { name: "Stop", exact: true }).click();
  const site = await siteReport("cancelled");

  expect(site.pages.map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
  await expect(panel().getByRole("list", { name: "Audited pages" }).locator(".site-page-status")).toHaveText(["Skipped", "Skipped", "Skipped"]);
  await expect(panel().getByRole("button", { name: "Audit site", exact: true })).toBeVisible();
  await writeFile(testInfo.outputPath("site-cancelled.json"), JSON.stringify(site.pages.map(({ route, status }) => ({ route, status })), null, 2));
});

async function signOuts(): Promise<number> {
  return Value.Parse(SignOutCounter, await (await fetch("http://127.0.0.1:45173/audit-lab-signouts.json")).json()).signOuts;
}

test("cancels redirects and page navigations to excluded routes before they are requested", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const before = await signOuts();

  // The account link redirects to an allowed page and then to /api/logout; the members page script also navigates there.
  const discovery = await page.evaluate((route) => window.mauxi!.auditDiscover({ fixture: "vite", route }), MEMBERS);
  expect(discovery.routes.map((item) => item.route)).toEqual([MEMBERS, BLOG, LAB, ABOUT]);
  expect(discovery.excluded).toContainEqual({ route: ACCOUNT, reason: `Redirects to an excluded route (${EXCLUDED})` });

  const start = await page.evaluate((route) => window.mauxi!.auditDiscover({ fixture: "vite", route }).then(() => "resolved", (error: Error) => error.message), ACCOUNT);
  expect(start).toContain("The start page redirects outside the allowed routes.");

  const site = await page.evaluate((routes) => window.mauxi!.auditSite({ fixture: "vite", routes }), [ACCOUNT]);
  expect(site.pages.map((item) => [item.route, item.status])).toEqual([[ACCOUNT, "failed"]]);
  expect(site.pages[0].error).toContain(`The page redirects to an excluded route (${EXCLUDED}).`);

  const single = await page.evaluate((route) => window.mauxi!.auditRun({ fixture: "vite", route }).then(() => "resolved", (error: Error) => error.message), ACCOUNT);
  expect(single).toContain(`The page redirects to an excluded route (${EXCLUDED}).`);

  const after = await signOuts();
  await writeFile(testInfo.outputPath("excluded-redirects.json"), JSON.stringify({ discovery: { routes: discovery.routes, excluded: discovery.excluded }, start, site: site.pages.map(({ route, status, error }) => ({ route, status, error })), single, signOuts: { before, after } }, null, 2));
  expect(after).toBe(before);
});
