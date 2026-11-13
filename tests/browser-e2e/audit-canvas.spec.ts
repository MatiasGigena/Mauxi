import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIT_PROFILES } from "../../src/application/audit-contract";
import { launch, text } from "../helpers/fake-provider";

async function boardStates(page: Page) {
  return page.locator(".snapshot-board").evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-profile-id"),
    spotlight: node.getAttribute("data-spotlight"),
    width: node.getBoundingClientRect().width,
    caption: node.querySelector(".snapshot-width")?.textContent ?? null,
    rail: node.querySelector(".snapshot-rail") ? getComputedStyle(node.querySelector(".snapshot-rail")!).display : null,
  })));
}

// The canvas after the Vite audit lab's entry audit: width-first captions, flat snapshot boards under elevated live
// previews, a matrix-wide title bar, and a spotlight that follows the finding hovered or selected in the panel.
test("audit canvas: captions, live primacy, marker density and finding spotlight", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-canvas-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html", "Local model");
  const evidence: Array<{ step: string; boards: Awaited<ReturnType<typeof boardStates>> }> = [];

  try {
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await expect(panel.getByRole("button", { name: "Re-run" })).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".workspace-notice")).toHaveCount(0, { timeout: 15_000 });
    const boards = page.locator(".snapshot-board");
    await expect(boards).toHaveCount(AUDIT_PROFILES.length);

    // Every board leads with its width, however narrow it is on screen.
    const overview = await boardStates(page);
    evidence.push({ step: "overview", boards: overview });

    for (const board of overview) {
      const profile = AUDIT_PROFILES.find((item) => item.id === board.id)!;
      expect(board.caption).toBe(String(profile.width));
      expect(board.spotlight).toBeNull();
    }

    // Narrow boards trade marker boxes for a page rail; their markers stay real buttons.
    expect(overview.filter((board) => board.width < 120).length).toBeGreaterThan(0);
    const railed = await page.locator('.snapshot-board[data-profile-id="phone-sm"] .snapshot-rail').evaluate((node) => getComputedStyle(node).display);
    expect(railed).toBe("block");
    await expect(page.locator('.snapshot-board[data-profile-id="phone-sm"] .finding-marker').first()).toBeAttached();

    // Live previews carry the elevation; snapshot boards are flat.
    expect(await page.locator('.artboard[data-preview-id="desktop"]').evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");
    expect(await boards.first().evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");

    // The title bar spans the matrix below it.
    const title = (await page.locator(".audit-matrix-title").boundingBox())!;
    const extent = await boards.evaluateAll((nodes) => Math.max(...nodes.map((node) => node.getBoundingClientRect().right)) - Math.min(...nodes.map((node) => node.getBoundingClientRect().left)));
    expect(title.width).toBeGreaterThanOrEqual(extent - 2);
    await page.screenshot({ path: testInfo.outputPath("01-overview.png") });

    // Hovering a finding spotlights the boards it was seen on and dims the rest.
    const first = panel.locator(".finding-card").first();
    const findingId = (await first.getAttribute("data-finding-id"))!;
    await first.hover();
    await expect(boards.filter({ has: page.locator(`[data-spotlit]`) }).first()).toBeAttached();
    const hovered = await boardStates(page);
    evidence.push({ step: `hover ${findingId}`, boards: hovered });
    expect(hovered.some((board) => board.spotlight === "lit")).toBe(true);
    expect(hovered.some((board) => board.spotlight === "dimmed")).toBe(true);
    expect(hovered.every((board) => board.spotlight === "lit" || board.spotlight === "dimmed")).toBe(true);
    await expect(page.locator('.snapshot-board[data-spotlight="dimmed"]').first()).toHaveCSS("opacity", "0.45");
    await page.screenshot({ path: testInfo.outputPath("02-hover-spotlight.png") });

    // Leaving the list clears the spotlight; selecting keeps it.
    await page.mouse.move(5, 400);
    await expect(page.locator(".snapshot-board[data-spotlight]")).toHaveCount(0);
    await first.locator(".finding-summary").click();
    await page.mouse.move(5, 400);
    await expect(page.locator('.snapshot-board[data-spotlight="lit"]').first()).toBeVisible();
    await expect(page.locator(".finding-marker[data-spotlit]").first()).toBeAttached();
    evidence.push({ step: `selected ${findingId}`, boards: await boardStates(page) });
    await page.screenshot({ path: testInfo.outputPath("03-selected-spotlight.png") });

    // The same canvas in light mode.
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.screenshot({ path: testInfo.outputPath("04-selected-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

    await writeFile(testInfo.outputPath("audit-canvas-evidence.json"), JSON.stringify(evidence, null, 2));
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
