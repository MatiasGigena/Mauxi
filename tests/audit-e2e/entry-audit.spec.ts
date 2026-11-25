import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIT_PROFILES, type AuditReport } from "../../src/application/audit-contract";

interface EntryLog { states: Array<{ running: boolean; at: number }>; reports: Array<{ at: number; snapshots: string[] }>; streamed: Array<{ at: number; profileId: string }> }

interface Rect { x: number; y: number; width: number; height: number }

interface Layout { boards: Array<{ id: string; state: string | null; rect: Rect; visible: boolean }>; free: Rect; zoom: number }

/** The repeatable record of the run: the profile matrix, where every board was at entry and after the report, and the run log. */
interface Summary { profiles: Array<{ id: string; label: string; width: number; height: number }>; forming?: Layout; report?: Layout & { durationMs: number; widthsScanned: number; summary: AuditReport["summary"]; axe?: string[] }; runs?: number }

declare global { interface Window { entryLog?: EntryLog; lastAuditReport?: AuditReport | null } }

let application: ElectronApplication;
let page: Page;
const summary: Summary = { profiles: AUDIT_PROFILES.map(({ id, label, width, height }) => ({ id, label, width, height })) };

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?fixture=vite&path=/audit-lab.html" }, recordVideo: { dir: testInfo.outputPath("video") } });
  page = await application.firstWindow();
  // Listen before the previews connect: the canvas starts the audit by itself as soon as the Desktop preview is ready.
  await page.evaluate(() => {
    const log: EntryLog = { states: [], reports: [], streamed: [] };
    window.entryLog = log;
    window.mauxi!.onAuditState((running) => log.states.push({ running, at: Date.now() }));
    window.mauxi!.onAuditReport((report) => { window.lastAuditReport = report; log.reports.push({ at: Date.now(), snapshots: report.snapshots.map((snapshot) => snapshot.profileId) }); });
    window.mauxi!.onAuditProgress((progress) => { if (progress.snapshot) log.streamed.push({ at: Date.now(), profileId: progress.snapshot.profileId }); });
  });
});

test.afterAll(async () => { await application?.close(); });

/** Written after each step, so a failing step still leaves the layout it measured. */
async function record(): Promise<void> {
  await writeFile(path.resolve("test-results/audit/entry-audit-summary.json"), JSON.stringify({ ...summary, log: await page.evaluate(() => window.entryLog) }, null, 2));
}

const panel = () => page.getByRole("complementary", { name: "Responsive audit" });
const runs = () => page.evaluate(() => window.entryLog!.states.filter((state) => state.running).length);

/** Every live preview and audit board, with whether it lies fully in the free canvas: below the top bar, above the chat dock, left of the panel. */
async function layout(): Promise<Layout> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const top = document.querySelector(".topbar")!.getBoundingClientRect().bottom;
    const right = document.querySelector(".audit-panel")?.getBoundingClientRect().left ?? canvas.right;
    const bottom = document.querySelector(".chat-dock")!.getBoundingClientRect().top;
    const round = (rect: DOMRect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });

    const boards = [...document.querySelectorAll<HTMLElement>(".artboard")].map((node) => {
      const rect = node.getBoundingClientRect();

      return { id: node.dataset.profileId ?? node.dataset.previewId ?? "", state: node.dataset.state ?? null, rect: round(rect),
        visible: rect.width > 0 && rect.left >= canvas.left - .5 && rect.top >= top - .5 && rect.right <= right + .5 && rect.bottom <= bottom + .5 };
    });

    return { boards, free: round(new DOMRect(canvas.left, top, right - canvas.left, bottom - top)), zoom: Number(document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value) };
  });
}

/** Board headers keep their screen size: no header may cover a board in the row above. */
function overlaps(boards: Array<{ rect: Rect }>): number {
  let count = 0;

  for (const a of boards) for (const b of boards) {
    if (a === b) continue;

    if (a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width && a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height) count++;
  }

  return count;
}

test("the canvas opens on the two live previews while the panel audits, then offers the snapshots", async ({}, testInfo) => {
  // No click: the panel opens with the run's progress beside the two live previews; the canvas shows nothing else.
  await expect(panel().getByRole("status")).toBeVisible({ timeout: 60_000 });
  await expect(panel().getByRole("status")).toContainText("%");
  const offer = page.getByRole("status", { name: "Audit snapshots ready" });
  const boards = page.locator(".snapshot-board");
  await expect(page.locator(".artboard[data-preview-id]")).toHaveCount(2);
  await expect(page.locator(".audit-sheet")).toHaveCount(0);
  await expect(boards).toHaveCount(0);
  await expect(offer).toHaveCount(0);
  await expect(page.locator(".audit-matrix-title")).toHaveCount(0);
  // The previews settle into the canvas the panel leaves free.
  await expect.poll(async () => (await layout()).boards.filter((board) => !board.visible).map((board) => board.id), { timeout: 5_000 }).toEqual([]);
  const forming = await layout();
  summary.forming = forming;
  expect(forming.boards.map((board) => board.id).sort()).toEqual(["desktop", "mobile"]);
  expect(forming.zoom).toBeGreaterThanOrEqual(0.25);
  await page.screenshot({ path: testInfo.outputPath("entry-previews.png") });
  await record();

  // Snapshots stream to the panel's run, not the canvas: still only the two previews while they come in.
  await expect.poll(() => page.evaluate(() => window.entryLog!.streamed.length), { timeout: 120_000 }).toBeGreaterThan(0);
  await expect(boards).toHaveCount(0);
  await expect(offer).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => window.entryLog!.reports.length), { timeout: 150_000 }).toBe(1);
  const log = (await page.evaluate(() => window.entryLog))!;
  expect(log.streamed.map((item) => item.profileId)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));
  expect(Math.max(...log.streamed.map((item) => item.at))).toBeLessThanOrEqual(log.reports[0].at);
  const report = (await page.evaluate(() => window.lastAuditReport))!;
  expect(report.snapshots.slice(0, AUDIT_PROFILES.length).map((snapshot) => snapshot.profileId)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));
  expect(report.profiles.map((profile) => profile.id)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));
  await expect(panel().locator(".audit-panel-header p")).toHaveText(`${report.route}${AUDIT_PROFILES.length} viewports · ${report.widthsScanned} widths`);
  await expect(panel().getByRole("button", { name: "Re-run", exact: true })).toBeVisible();

  // Only then the offer drops in under the top bar, naming what it holds; the camera has not moved and no tile is drawn yet.
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Snapshots ready");
  await expect(offer).toContainText(`${report.snapshots.length} captures · ${report.summary.bug} ${report.summary.bug === 1 ? "bug" : "bugs"}`);
  await expect.poll(() => offer.evaluate((node) => getComputedStyle(node).opacity), { timeout: 3_000 }).toBe("1");
  expect(await offer.evaluate((node) => node.contains(document.activeElement))).toBe(false);
  await expect(boards).toHaveCount(0);
  const offered = await layout();
  expect(offered.zoom).toBe(forming.zoom);
  const topbar = (await page.locator(".topbar").boundingBox())!;
  const card = (await offer.boundingBox())!;
  expect(card.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
  expect(card.x + card.width).toBeLessThanOrEqual(offered.free.x + offered.free.width);
  await page.screenshot({ path: testInfo.outputPath("entry-offer.png") });

  // Taking it puts every snapshot on the canvas, entering in sequence while the camera pulls back to fit them all.
  await offer.getByRole("button", { name: "Show snapshots" }).click();
  await expect(boards).toHaveCount(report.snapshots.length);
  await expect(page.locator('[data-testid="canvas"][data-sheet-entering]')).toHaveCount(1);
  const delays = await boards.evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).animationDelay)));
  expect(delays.slice(1).every((delay, at) => delay >= delays[at])).toBe(true);
  expect(delays.at(-1)!).toBeGreaterThan(delays[0]);
  await expect(offer).toHaveCount(0);
  await expect(page.locator('[data-testid="canvas"][data-sheet-entering]')).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator(".snapshot-board[data-state]")).toHaveCount(0);
  let last = "";
  await expect.poll(async () => { const now = JSON.stringify((await layout()).boards.map((board) => board.rect)); const same = now === last; last = now;

    return same; }, { intervals: [200], timeout: 10_000 }).toBe(true);
  const done = await layout();
  summary.report = { ...done, durationMs: report.durationMs, widthsScanned: report.widthsScanned, summary: report.summary, axe: report.axe?.profiles };
  await page.screenshot({ path: testInfo.outputPath("entry-snapshots.png") });
  await record();
  expect(done.zoom).toBeLessThan(forming.zoom);
  expect(done.boards.filter((board) => !board.visible).map((board) => board.id)).toEqual([]);
  expect(overlaps(done.boards)).toBe(0);

  // It ran once: re-renders, the report and the offer do not start it again.
  await page.waitForTimeout(3_000);
  expect(await runs()).toBe(1);
});

test("Re-run forms the matrix again, and Stop returns to the last report without another run", async ({}, testInfo) => {
  await panel().getByRole("button", { name: "Re-run", exact: true }).click();
  await expect(page.locator('.snapshot-board[data-state="queued"]').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.entryLog!.reports.length), { timeout: 150_000 }).toBe(2);
  await expect(page.locator(".snapshot-board[data-state]")).toHaveCount(0);
  expect(await runs()).toBe(2);

  await panel().getByRole("button", { name: "Re-run", exact: true }).click();
  await expect(page.locator('.snapshot-board[data-state="queued"]').first()).toBeVisible();
  await panel().getByRole("button", { name: "Stop audit", exact: true }).click();
  await expect(panel().getByRole("alert")).toHaveText("Audit cancelled");
  await expect(page.locator(".snapshot-board[data-state]")).toHaveCount(0);
  const report = (await page.evaluate(() => window.lastAuditReport))!;
  await expect(page.locator(".snapshot-board")).toHaveCount(report.snapshots.length);
  await page.screenshot({ path: testInfo.outputPath("after-stop.png") });
  await page.waitForTimeout(3_000);
  expect(await runs()).toBe(3);
  summary.runs = await runs();
  await record();
});
