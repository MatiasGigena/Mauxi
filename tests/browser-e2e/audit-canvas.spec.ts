import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIT_PROFILES, sweepWidths } from "../../src/application/audit-contract";
import { showSnapshots } from "../helpers/entry-audit";
import { launch, text } from "../helpers/fake-provider";

interface Box { x: number; y: number; width: number; height: number }

/** Every tile on the audit sheet (or stage mode's grid) and the stage, captions, spotlight, image and surface sizes, and the camera zoom. */
async function sheetState(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();

      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const read = (node: HTMLElement) => {
      const image = node.querySelector("img");
      const rail = node.querySelector(".snapshot-rail");

      return {
        id: node.dataset.profileId!, spotlight: node.dataset.spotlight ?? null, cropped: node.dataset.cropped !== undefined,
        caption: node.querySelector(".snapshot-width")?.textContent ?? null, rect: box(node)!, surface: box(node.querySelector(".snapshot-surface"))!,
        image: image ? { ...box(image)!, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null,
        rail: rail ? getComputedStyle(rail).display : null, markers: [...node.querySelectorAll(".finding-marker")].map((marker) => box(marker)!),
        grouped: node.querySelectorAll(".finding-marker[data-grouped]").length,
        crop: node.querySelector(".snapshot-crop button")?.getAttribute("aria-label") ?? null,
      };
    };

    const tiles = [...document.querySelectorAll<HTMLElement>(".snapshot-board")].map(read);
    const staged = [...document.querySelectorAll<HTMLElement>(".stage-tile")].map(read);

    const lanes = [...document.querySelectorAll<HTMLElement>(".sheet-lane-label")].map((node) => ({ id: node.dataset.lane!, gutter: node.dataset.gutter !== undefined, rect: box(node)! }));
    const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const top = document.querySelector(".topbar")!.getBoundingClientRect().bottom;
    const right = document.querySelector(".audit-panel")?.getBoundingClientRect().left ?? canvas.right;
    const bottom = document.querySelector(".chat-dock")!.getBoundingClientRect().top;
    const bars = [...document.querySelectorAll(".width-scope .scope-bar")];

    return {
      tiles, staged, lanes, zoom: Number(document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value),
      free: { x: canvas.left, y: top, width: right - canvas.left, height: bottom - top },
      live: [...document.querySelectorAll(".artboard[data-preview-id]")].map((node) => box(node)!),
      sheet: box(document.querySelector(".audit-sheet")), stage: box(document.querySelector(".audit-stage")), title: box(document.querySelector(".stage-grid-title")),
      bars: bars.length, lit: bars.filter((bar) => bar.hasAttribute("data-lit")).length,
    };
  });
}

type SheetState = Awaited<ReturnType<typeof sheetState>>;

const inside = (box: Box, area: Box) => box.x >= area.x - .5 && box.y >= area.y - .5 && box.x + box.width <= area.x + area.width + .5 && box.y + box.height <= area.y + area.height + .5;
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - .5 && b.x < a.x + a.width - .5 && a.y < b.y + b.height - .5 && b.y < a.y + a.height - .5;

/** Waits until a locator's screen box stops changing (the camera finished flying). */
async function still(locator: import("@playwright/test").Locator) {
  let last = "";
  await expect.poll(async () => { const now = JSON.stringify(await locator.boundingBox()); const same = now === last; last = now;

    return same; }, { intervals: [150], timeout: 10_000 }).toBe(true);
}

// The canvas after the Vite audit lab's entry audit: one audit sheet under elevated live previews, tiles of three sizes in
// lanes, captions that lead with the width, a width scope and a spotlight that follow the panel. Selecting a finding puts
// the canvas in stage mode: every tile moves to a grid beside the previews and the finding's snapshots go large on the
// stage, where a "Seen at" chip locates one and its tile opens in place; Esc returns to the sheet.
test("audit sheet and stage: lanes, tile sizes, crops, finding spotlight, staging and locating a finding's tile", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-audit-canvas-"));
  const { page, close } = await launch(state, () => text("No browser actions needed."), {}, "/audit-lab.html", "Local model");
  const evidence: Array<{ step: string; sheet: SheetState }> = [];

  /** Records the sheet for a step and rewrites the evidence file, so a failing step still leaves what it measured. */
  const snap = async (step: string) => {
    const sheet = await sheetState(page);
    evidence.push({ step, sheet });
    await writeFile(testInfo.outputPath("audit-canvas-evidence.json"), JSON.stringify(evidence, null, 2));

    return sheet;
  };

  try {
    const panel = page.getByRole("complementary", { name: "Responsive audit" });
    await expect(panel.getByRole("button", { name: "Re-run" })).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".workspace-notice")).toHaveCount(0, { timeout: 15_000 });
    await showSnapshots(page);
    const boards = page.locator(".snapshot-board");
    await expect(boards).toHaveCount(AUDIT_PROFILES.length);
    const overview = await snap("overview");

    // Profile order, a caption that leads with the width, nothing spotlit yet.
    expect(overview.tiles.map((tile) => tile.id)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));

    for (const tile of overview.tiles) {
      expect(tile.caption).toBe(String(AUDIT_PROFILES.find((profile) => profile.id === tile.id)!.width));
      expect(tile.spotlight).toBeNull();
    }

    // Lanes in profile order; tiles come in three widths, 260 : 360 : 520 canvas units, whatever their true width.
    expect(overview.lanes.map((lane) => lane.id)).toEqual(["compact", "medium", "wide", "stress"]);
    const widthOf = (id: string) => overview.tiles.find((tile) => tile.id === id)!.rect.width;
    expect(new Set(["phone-sm", "android", "phone", "phone-lg", "zoom-400", "text-spacing"].map((id) => Math.round(widthOf(id)))).size).toBe(1);
    expect(new Set(["tablet", "phone-landscape", "tablet-landscape", "zoom-200"].map((id) => Math.round(widthOf(id)))).size).toBe(1);
    expect(new Set(["laptop", "laptop-hd", "desktop", "desktop-wide", "text-spacing-wide"].map((id) => Math.round(widthOf(id)))).size).toBe(1);
    expect(widthOf("tablet") / widthOf("phone-sm")).toBeCloseTo(360 / 260, 1);
    expect(widthOf("desktop") / widthOf("phone-sm")).toBeCloseTo(520 / 260, 1);

    // The overview fits far closer than true-size full pages did (about 9%), with every board and label in the free canvas
    // and no caption or label covering another tile.
    expect(overview.zoom).toBeGreaterThan(0.15);
    const placed = [...overview.live, ...overview.tiles.map((tile) => tile.rect), ...overview.lanes.map((lane) => lane.rect)];
    expect(placed.filter((box) => !inside(box, overview.free))).toEqual([]);
    expect(placed.flatMap((a, i) => placed.slice(i + 1).filter((b) => overlap(a, b)))).toEqual([]);
    expect(inside(overview.sheet!, overview.free)).toBe(true);

    // Image and markers share one scale; tiles crop long pages and never run taller than a short one.
    for (const tile of overview.tiles) {
      const image = tile.image!;
      expect(image.width / image.height).toBeCloseTo(image.naturalWidth / image.naturalHeight, 1);

      for (const marker of tile.markers) expect(marker.x).toBeGreaterThanOrEqual(image.x - 1);

      if (tile.cropped) expect(tile.surface.height).toBeLessThan(image.height - 1);
      else expect(Math.abs(tile.surface.height - image.height)).toBeLessThan(1.5);
    }

    expect(overview.tiles.find((tile) => tile.id === "zoom-400")!.cropped).toBe(false);
    expect(overview.tiles.find((tile) => tile.id === "phone-sm")!.cropped).toBe(true);

    // Narrow tiles trade marker boxes for a page rail; their markers stay real buttons.
    expect(overview.tiles.find((tile) => tile.id === "phone-sm")!.rail).toBe("block");
    await expect(page.locator('.snapshot-board[data-profile-id="phone-sm"] .finding-marker').first()).toBeAttached();

    // Live previews carry the elevation (on their closed frame); the sheet and its tiles are flat. The width scope has a mark per measured width.
    expect(await page.locator('.artboard[data-preview-id="desktop"]').evaluate((node) => getComputedStyle(node, "::after").boxShadow)).not.toBe("none");
    expect(await boards.first().evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
    expect(overview.bars).toBe(sweepWidths().length);
    expect(overview.stage).toBeNull();
    expect(overview.lit).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("01-overview.png") });

    // Hovering a finding spotlights the tiles it was seen on, dims the rest and lights its widths on the width scope.
    const first = panel.locator(".finding-card").first();
    const findingId = (await first.getAttribute("data-finding-id"))!;
    await first.hover();
    await expect(page.locator(".snapshot-board[data-spotlight]").first()).toBeAttached();
    const hovered = await snap(`hover ${findingId}`);
    expect(hovered.tiles.some((tile) => tile.spotlight === "lit")).toBe(true);
    expect(hovered.tiles.some((tile) => tile.spotlight === "dimmed")).toBe(true);
    expect(hovered.tiles.every((tile) => tile.spotlight === "lit" || tile.spotlight === "dimmed")).toBe(true);
    expect(hovered.lit).toBeGreaterThan(0);
    expect(hovered.lit).toBeLessThan(hovered.bars);
    await expect(page.locator('.snapshot-board[data-spotlight="dimmed"]').first()).toHaveCSS("opacity", "0.45");
    await page.screenshot({ path: testInfo.outputPath("02-hover-spotlight.png") });

    // Leaving the list clears the spotlight. Selecting stages the finding: every tile moves to a grid beside the previews,
    // ringed where the finding was seen, and those snapshots go large on the stage, with the finding's markers leading.
    await page.mouse.move(5, 400);
    await expect(page.locator(".snapshot-board[data-spotlight]")).toHaveCount(0);
    await first.locator(".finding-summary").click();
    await page.mouse.move(5, 400);
    const stage = page.getByRole("region", { name: "Stage: finding 1" });
    await expect(stage).toBeVisible();
    await still(stage);
    const staged = await snap(`staged ${findingId}`);
    await page.screenshot({ path: testInfo.outputPath("03-staged.png") });
    // The same stage in light mode, once its colours settle.
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath("03-staged-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

    // The grid keeps every tile in profile order, all one width, right of the live previews, lane names in a gutter.
    expect(staged.tiles.map((tile) => tile.id)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));
    expect(new Set(staged.tiles.map((tile) => Math.round(tile.rect.width))).size).toBe(1);
    const previewsRight = Math.max(...staged.live.map((box) => box.x + box.width));
    expect(staged.tiles.every((tile) => tile.rect.x > previewsRight)).toBe(true);
    expect(staged.lanes.every((lane) => lane.gutter)).toBe(true);
    expect(staged.sheet).toBeNull();

    // The stage shows exactly the lit tiles, in the same order, larger than in the grid.
    const lit = staged.tiles.filter((tile) => tile.spotlight === "lit").map((tile) => tile.id);
    expect(lit.length).toBeGreaterThan(0);
    expect(staged.tiles.filter((tile) => tile.spotlight === "dimmed").length).toBe(staged.tiles.length - lit.length);
    expect(staged.staged.map((tile) => tile.id)).toEqual(lit);

    for (const tile of staged.staged) {
      expect(tile.rect.width).toBeGreaterThan(staged.tiles.find((item) => item.id === tile.id)!.rect.width * 1.5);
      expect(tile.image!.width / tile.image!.height).toBeCloseTo(tile.image!.naturalWidth / tile.image!.naturalHeight, 1);
    }

    await expect(page.locator(`.stage-tile .finding-marker[data-spotlit]`).first()).toBeAttached();
    await expect(stage).toContainText(await first.locator(".finding-heading strong").innerText());

    // Nothing in stage mode overlaps, and the camera fits it all in the free canvas.
    const stagedBoxes = [...staged.live, ...staged.tiles.map((tile) => tile.rect), ...staged.staged.map((tile) => tile.rect), ...staged.lanes.map((lane) => lane.rect), staged.title!];
    expect(stagedBoxes.flatMap((a, i) => stagedBoxes.slice(i + 1).filter((b) => overlap(a, b)))).toEqual([]);
    expect([...staged.tiles.map((tile) => tile.rect), ...staged.live].filter((box) => overlap(box, staged.stage!))).toEqual([]);
    expect([...stagedBoxes, staged.stage!].filter((box) => !inside(box, staged.free))).toEqual([]);

    // "Seen at" lists the staged snapshots; a chip brings its stage tile into view at no more than 1:1 snapshot pixels.
    const seen = first.getByRole("group", { name: "Seen at" });
    await expect(seen.getByRole("button")).toHaveCount(staged.staged.length);
    await seen.getByRole("button", { name: "Show on the Small phone snapshot" }).click();
    const tile = page.locator('.stage-tile[data-profile-id="phone-sm"]');
    await expect.poll(async () => (await tile.boundingBox())!.width).toBeGreaterThan(200);
    await still(tile);
    const located = await snap("located phone-sm");
    const phone = located.staged.find((item) => item.id === "phone-sm")!;
    expect(phone.image!.width).toBeLessThanOrEqual(phone.image!.naturalWidth + 1);
    await expect(page.locator(".peek-bar")).toContainText("Peeking at Small phone");

    // Its marker lay below the crop, so the tile opened to the full page and the camera centred on the marker.
    await expect(tile).not.toHaveAttribute("data-cropped");
    const marker = (await tile.locator(".finding-marker[data-spotlit]").boundingBox())!;
    expect(inside({ ...marker, width: Math.min(marker.width, 40), height: Math.min(marker.height, 40) }, located.free)).toBe(true);
    expect(Math.abs(phone.surface.height - phone.image!.height)).toBeLessThan(1.5);
    await page.screenshot({ path: testInfo.outputPath("04-located.png") });

    // An open tile crops back to the first screen keeping its button under the pointer, and opens again in place.
    const crop = tile.getByRole("button", { name: "Crop Small phone to the first screen" });
    // The bottom of the open page lies below the screen: the clicks are dispatched to the buttons there.
    const before = (await crop.boundingBox())!;
    await crop.dispatchEvent("click");
    await expect(tile).toHaveAttribute("data-cropped", "true");
    const cropped = (await snap("cropped phone-sm")).staged.find((item) => item.id === "phone-sm")!;
    expect(cropped.surface.height).toBeLessThan(cropped.image!.height - 1);
    const reopen = tile.getByRole("button", { name: /^Show the full Small phone page, \d+ more markers? below$/ });
    const after = (await reopen.boundingBox())!;
    expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("05-cropped.png") });
    await reopen.dispatchEvent("click");
    await expect(tile).not.toHaveAttribute("data-cropped");

    // Esc ends the peek, then leaves the stage: the tiles go back to the sheet and the finding is no longer selected.
    await page.keyboard.press("Escape");
    await expect(page.locator(".peek-bar")).toHaveCount(0);
    await expect(stage).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stage).toHaveCount(0);
    await expect(page.locator(".stage-tile")).toHaveCount(0);
    await expect(first.locator(".finding-summary")).toHaveAttribute("aria-expanded", "false");
    await still(page.locator(".audit-sheet"));
    const unstaged = await snap("unstaged");
    expect(unstaged.lanes.some((lane) => lane.gutter)).toBe(false);
    expect(unstaged.tiles.map((item) => item.id)).toEqual(AUDIT_PROFILES.map((profile) => profile.id));
    await page.screenshot({ path: testInfo.outputPath("07-unstaged.png") });

    // The sheet says what it holds. After the camera wanders off, Fit brings the previews and the sheet back into the free canvas.
    await expect(page.locator(".sheet-head")).toContainText(`Snapshots${unstaged.tiles.length} captures`);
    await page.getByLabel("Camera zoom").fill("1");
    await page.getByRole("button", { name: "Fit everything in view" }).click();
    await still(page.locator(".audit-sheet"));
    const fitted = await snap("fitted");
    expect(inside(fitted.sheet!, fitted.free)).toBe(true);
    expect(fitted.live.filter((box) => !inside(box, fitted.free))).toEqual([]);
    expect(fitted.zoom).toBeCloseTo(unstaged.zoom, 2);
    await page.screenshot({ path: testInfo.outputPath("08-fitted.png") });

    // A full page opened on the sheet counts too: Fit zooms out to keep it in view.
    // At this zoom the tile is too narrow to show its own crop button, so the click goes to it directly.
    await page.locator('.snapshot-board[data-profile-id="phone-sm"] .snapshot-crop button').dispatchEvent("click");
    await expect(page.locator('.snapshot-board[data-profile-id="phone-sm"]')).not.toHaveAttribute("data-cropped");
    await page.getByRole("button", { name: "Fit everything in view" }).click();
    await still(page.locator(".audit-sheet"));
    const refitted = await snap("refitted");
    expect(inside(refitted.sheet!, refitted.free)).toBe(true);
    expect(refitted.zoom).toBeLessThan(fitted.zoom);
    await page.screenshot({ path: testInfo.outputPath("09-refitted-full-page.png") });
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
