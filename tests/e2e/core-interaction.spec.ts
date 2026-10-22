import { fitCanvas, selectFixture } from "../helpers/workspace-controls";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeSelections, resolvedSelection, revalidateSelection } from "../helpers/selection-evidence";

let application: ElectronApplication;
let page: Page;
let evidenceDirectory: string;

test.beforeAll(async ({}, testInfo) => {
  evidenceDirectory = testInfo.outputPath("captures");
  await mkdir(evidenceDirectory, { recursive: true });
  application = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173/?audit=manual", MAUXI_EVIDENCE_DIR: evidenceDirectory },
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => { await application?.close(); });

async function waitForBridge() {
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
}

async function proveFixture(fixture: "Vite" | "Next.js", sourceName: string) {
  await waitForBridge();
  await observeSelections(page);
  await page.waitForTimeout(250);
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');

  expect(await desktop.locator("body").evaluate(() => innerWidth)).toBe(1440);
  expect(await desktop.locator("body").evaluate(() => innerHeight)).toBe(900);
  expect(await mobile.locator("body").evaluate(() => innerWidth)).toBe(390);
  expect(await mobile.locator("body").evaluate(() => innerHeight)).toBe(844);
  await page.getByLabel("Camera zoom").fill("0.7");
  await expect.poll(async () => (await page.getByTestId("desktop-preview").boundingBox())!.width).toBe(1008);
  const artboard = page.locator('[data-preview-id="desktop"]');
  const header = artboard.locator(".artboard-header");
  const beforeDrag = await artboard.boundingBox();
  const headerBounds = await header.boundingBox();

  if (!beforeDrag || !headerBounds) throw new Error("Desktop artboard is not visible");
  await page.mouse.move(headerBounds.x + 80, headerBounds.y + 18);
  await page.mouse.down();
  await page.mouse.move(headerBounds.x + 112, headerBounds.y + 42);
  await page.mouse.up();
  const afterDrag = await artboard.boundingBox();
  expect(afterDrag!.x - beforeDrag.x).toBeCloseTo(32, 0);
  expect(afterDrag!.y - beforeDrag.y).toBeCloseTo(24, 0);
  expect(await desktop.locator("body").evaluate(() => innerWidth)).toBe(1440);
  expect(await mobile.locator("body").evaluate(() => innerWidth)).toBe(390);

  const initialSelectionCount = await page.locator(".selection-chip").count();
  await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();
  await desktop.locator('[data-testid="known-icon"]').click();
  await expect(desktop.locator('[data-testid="click-count"]')).toContainText("0");
  await expect(page.locator(".selection-chip")).toHaveCount(initialSelectionCount + 1);
  const evidence = await resolvedSelection(page);
  expect(evidence.source?.filePath).toContain(sourceName);
  expect(evidence.capture.source.method).toBe("react-grab");

  await page.getByRole("button", { name: "Select in Mobile", exact: true }).click();
  await mobile.locator('[data-testid="known-target"]').click();
  await expect(mobile.locator('[data-testid="click-count"]')).toContainText("0");
  await expect(page.locator(".selection-chip")).toHaveCount(initialSelectionCount + 2);

  await page.getByRole("button", { name: "Select in Mobile", exact: true }).click();
  await fitCanvas(page);
  const frameBounds = await page.getByTestId("desktop-preview").boundingBox();
  const before = new Set(await readdir(evidenceDirectory));
  await page.getByRole("button", { name: "Desktop actions", exact: true }).click();
  await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
  await expect(page.locator(".workspace-notice")).toContainText(`Captured desktop only · ${Math.ceil(frameBounds!.width)}×${Math.ceil(frameBounds!.height)}`);
  const created = (await readdir(evidenceDirectory)).filter((file) => !before.has(file));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatch(/^desktop-\d+-[0-9a-f-]{36}\.png$/);
  const evidenceName = fixture === "Vite" ? "vite-desktop-fit.png" : "next-desktop-fit.png";
  await rename(path.join(evidenceDirectory, created[0]), path.join(evidenceDirectory, evidenceName));
}

test("Vite: scaled picking, source provenance, viewport invariance, capture and HMR staleness", async () => {
  await proveFixture("Vite", "components/ProofCard.tsx");

  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const sourcePath = path.resolve("fixtures/vite/src/components/ProofCard.tsx");
  const original = await readFile(sourcePath, "utf8");

  try {
    await writeFile(sourcePath, original.replace("Run action", "Run changed action"));
    await expect(desktop.getByText("Run changed action")).toBeVisible({ timeout: 20_000 });
    expect(await revalidateSelection(page)).toBe("stale");
    await expect(page.locator(".selection-chip").first()).toHaveClass(/stale/);
  } finally {
    await writeFile(sourcePath, original);
  }
});

test("Vite local cookies are shared by the two same-workspace previews", async () => {
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
  await desktop.getByText("Use local test account").click();
  await mobile.locator("body").evaluate(() => location.reload());
  await expect(mobile.locator('[data-testid="auth-state"]')).toHaveText("Authenticated locally");
});

test("Next App Router/Webpack: server-client fixture has precise source picking", async () => {
  await selectFixture(page, "next");
  await proveFixture("Next.js", "components/ProofCard.tsx");
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
  await desktop.getByText("Use local test account").click();
  await expect(desktop.locator('[data-testid="auth-state"]')).toHaveText("Authenticated on server");

  const sourcePath = path.resolve("fixtures/next/app/components/ProofCard.tsx");
  const original = await readFile(sourcePath, "utf8");

  try {
    await writeFile(sourcePath, original.replace("Run action", "Run changed action"));
    await expect(desktop.getByText("Run changed action")).toBeVisible({ timeout: 30_000 });
    await expect(page.frameLocator('[data-testid="mobile-preview"]').getByText("Run changed action")).toBeVisible({ timeout: 30_000 });
    expect(await revalidateSelection(page)).toBe("stale");
    await expect(page.locator(".selection-chip").first()).toHaveClass(/stale/);
  } finally {
    await writeFile(sourcePath, original);
  }

  await expect(page.frameLocator('[data-testid="mobile-preview"]').getByText("Run action", { exact: true })).toBeVisible();
});

test("Next Link client navigation reaches the peer once without remounting the source", async () => {
  await page.reload();
  await selectFixture(page, "next");
  await waitForBridge();
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  const peer = page.frames().find((frame) => frame.url().includes("mauxiPreview=mobile"));
  const peerNavigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === peer) peerNavigations.push(frame.url()); });

  const marker = await desktop.locator("body").evaluate(() => { document.body.dataset.instance = crypto.randomUUID();

  return document.body.dataset.instance; });

  await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
  await desktop.getByRole("link", { name: "Next client route", exact: true }).click();
  await expect.poll(() => peer?.url()).toBe("http://127.0.0.1:45000/?view=linked");
  await expect(mobile.getByRole("link", { name: "Next client route", exact: true })).toBeVisible();
  expect(peerNavigations.filter((url) => url.endsWith("/?view=linked"))).toHaveLength(1);
  expect(await desktop.locator("body").getAttribute("data-instance")).toBe(marker);
});
