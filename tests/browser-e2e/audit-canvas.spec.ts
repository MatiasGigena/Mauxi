import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIT_PROFILES, sweepWidths } from "../../src/application/audit-contract";
import { launch, text } from "../helpers/fake-provider";

interface Box { x: number; y: number; width: number; height: number }

/** Every tile on the audit sheet, its caption and spotlight, how its image and surface are sized, and the camera zoom. */
async function sheetState(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();

      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };

    const tiles = [...document.querySelectorAll<HTMLElement>(".snapshot-board")].map((node) => {
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
    });

    const lanes = [...document.querySelectorAll<HTMLElement>(".sheet-lane-label")].map((node) => ({ id: node.dataset.lane!, rect: box(node)! }));
    const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const top = document.querySelector(".topbar")!.getBoundingClientRect().bottom;
    const right = document.querySelector(".audit-panel")?.getBoundingClientRect().left ?? canvas.right;
    const bottom = document.querySelector(".chat-dock")!.getBoundingClientRect().top;
    const cells = [...document.querySelectorAll(".sweep-cells span")];

    return {
      tiles, lanes, zoom: Number(document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value),
      free: { x: canvas.left, y: top, width: right - canvas.left, height: bottom - top },
      live: [...document.querySelectorAll(".artboard[data-preview-id]")].map((node) => box(node)!),
      sheet: box(document.querySelector(".audit-sheet")), cells: cells.length, lit: cells.filter((cell) => cell.hasAttribute("data-lit")).length,
    };
  });
}

type SheetState = Awaited<ReturnType<typeof sheetState>>;

const inside = (box: Box, area: Box) => box.x >= area.x - .5 && box.y >= area.y - .5 && box.x + box.width <= area.x + area.width + .5 && box.y + box.height <= area.y + area.height + .5;
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - .5 && b.x < a.x + a.width - .5 && a.y < b.y + b.height - .5 && b.y < a.y + a.height - .5;

// The canvas after the Vite audit lab's entry audit: one audit sheet under elevated live previews, tiles of three sizes in
// lanes, captions that lead with the width, a sweep strip and a spotlight that follow the panel, and tiles that open in place.
test("audit sheet: lanes, tile sizes, crops, finding spotlight and locating a finding's tile", async ({}, testInfo) => {
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

    // Live previews carry the elevation; the sheet and its tiles are flat. The sweep strip has a cell per measured width.
    expect(await page.locator('.artboard[data-preview-id="desktop"]').evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe("none");
    expect(await boards.first().evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
    expect(overview.cells).toBe(sweepWidths().length);
    expect(overview.lit).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("01-overview.png") });

    // Hovering a finding spotlights the tiles it was seen on, dims the rest and lights its widths on the sweep strip.
    const first = panel.locator(".finding-card").first();
    const findingId = (await first.getAttribute("data-finding-id"))!;
    await first.hover();
    await expect(page.locator(".snapshot-board[data-spotlight]").first()).toBeAttached();
    const hovered = await snap(`hover ${findingId}`);
    expect(hovered.tiles.some((tile) => tile.spotlight === "lit")).toBe(true);
    expect(hovered.tiles.some((tile) => tile.spotlight === "dimmed")).toBe(true);
    expect(hovered.tiles.every((tile) => tile.spotlight === "lit" || tile.spotlight === "dimmed")).toBe(true);
    expect(hovered.lit).toBeGreaterThan(0);
    expect(hovered.lit).toBeLessThan(hovered.cells);
    await expect(page.locator('.snapshot-board[data-spotlight="dimmed"]').first()).toHaveCSS("opacity", "0.45");
    await page.screenshot({ path: testInfo.outputPath("02-hover-spotlight.png") });

    // Leaving the list clears the spotlight; selecting keeps it.
    await page.mouse.move(5, 400);
    await expect(page.locator(".snapshot-board[data-spotlight]")).toHaveCount(0);
    await first.locator(".finding-summary").click();
    await page.mouse.move(5, 400);
    await expect(page.locator('.snapshot-board[data-spotlight="lit"]').first()).toBeVisible();
    await expect(page.locator(".finding-marker[data-spotlit]").first()).toBeAttached();
    const selected = await snap(`selected ${findingId}`);
    await page.screenshot({ path: testInfo.outputPath("03-selected-spotlight.png") });

    // "Seen at" lists the tiles the finding is lit on; a chip brings its tile into view at no more than 1:1 snapshot pixels.
    const seen = first.getByRole("group", { name: "Seen at" });
    await expect(seen.getByRole("button")).toHaveCount(selected.tiles.filter((tile) => tile.spotlight === "lit").length);
    await seen.getByRole("button", { name: "Show on the Small phone snapshot" }).click();
    const tile = page.locator('.snapshot-board[data-profile-id="phone-sm"]');
    await expect.poll(async () => (await tile.boundingBox())!.width).toBeGreaterThan(200);
    // The camera flies there; measure once it stops.
    let last = "";
    await expect.poll(async () => { const now = JSON.stringify(await tile.boundingBox()); const still = now === last; last = now;

      return still; }, { intervals: [150], timeout: 10_000 }).toBe(true);
    const located = await snap("located phone-sm");
    const phone = located.tiles.find((item) => item.id === "phone-sm")!;
    expect(phone.image!.width).toBeLessThanOrEqual(phone.image!.naturalWidth + 1);
    expect(phone.rail).toBe("none");

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
    const cropped = (await snap("cropped phone-sm")).tiles.find((item) => item.id === "phone-sm")!;
    expect(cropped.surface.height).toBeLessThan(cropped.image!.height - 1);
    const reopen = tile.getByRole("button", { name: /^Show the full Small phone page, \d+ more markers? below$/ });
    const after = (await reopen.boundingBox())!;
    expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("05-cropped.png") });
    await reopen.dispatchEvent("click");
    await expect(tile).not.toHaveAttribute("data-cropped");

    // The same canvas in light mode, once its colours settle.
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath("06-located-light.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  } finally {
    await close();
    await rm(state, { recursive: true, force: true });
  }
});
