import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

let application: ElectronApplication;
let page: Page;
const evidenceDirectory = path.resolve("evidence/captures");

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  application = await electron.launch({
    args: [path.resolve("dist-electron/main.js")],
    env: { ...process.env, MAUXI_PROOF: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_EVIDENCE_DIR: evidenceDirectory },
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => { await application?.close(); });

async function waitForBridge() {
  await expect(page.locator(".connection")).toContainText("bridge connected", { timeout: 30_000 });
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
}

async function proveFixture(fixture: "Vite" | "Next.js", sourceName: string) {
  await waitForBridge();
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');

  expect(await desktop.locator("body").evaluate(() => innerWidth)).toBe(1440);
  expect(await desktop.locator("body").evaluate(() => innerHeight)).toBe(900);
  expect(await mobile.locator("body").evaluate(() => innerWidth)).toBe(390);
  expect(await mobile.locator("body").evaluate(() => innerHeight)).toBe(844);
  await page.getByLabel("Camera zoom").fill("0.7");
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
  await page.getByTestId("selection-toggle").click();
  await desktop.locator('[data-testid="known-icon"]').click();
  await expect(desktop.locator('[data-testid="click-count"]')).toContainText("0");
  const selection = page.locator(".selection-chip").first();
  await expect(selection).toContainText(sourceName, { timeout: 15_000 });
  await expect(selection).toContainText("react-grab");

  await mobile.locator('[data-testid="known-target"]').click();
  await expect(mobile.locator('[data-testid="click-count"]')).toContainText("0");
  await expect(page.locator(".selection-chip")).toHaveCount(initialSelectionCount + 2);

  await page.getByTestId("selection-toggle").click();
  const before = new Set(await readdir(evidenceDirectory));
  await page.locator('[data-preview-id="desktop"] .artboard-actions button').click();
  await expect(page.locator(".connection")).toContainText("Captured desktop only · 1008×630");
  const created = (await readdir(evidenceDirectory)).filter((file) => !before.has(file));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatch(/^desktop-\d+\.png$/);
  const evidenceName = fixture === "Vite" ? "vite-desktop-70.png" : "next-desktop-70.png";
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
    await page.locator(".selection-chip").first().getByText("Revalidate").click();
    await expect(page.locator(".selection-chip").first()).toContainText("Stale");
  } finally {
    await writeFile(sourcePath, original);
  }
});

test("Vite local cookies are shared by the two same-workspace previews", async () => {
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  const mobile = page.frameLocator('[data-testid="mobile-preview"]');
  await desktop.getByText("Use local test account").click();
  await mobile.locator("body").evaluate(() => location.reload());
  await expect(mobile.locator('[data-testid="auth-state"]')).toHaveText("Authenticated locally");
});

test("Next App Router/Webpack: server-client fixture has precise source picking", async () => {
  await page.getByRole("button", { name: "Next.js" }).click();
  await proveFixture("Next.js", "components/ProofCard.tsx");
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  await desktop.getByText("Use local test account").click();
  await expect(desktop.locator('[data-testid="auth-state"]')).toHaveText("Authenticated on server");

  const sourcePath = path.resolve("fixtures/next/app/components/ProofCard.tsx");
  const original = await readFile(sourcePath, "utf8");
  try {
    await writeFile(sourcePath, original.replace("Run action", "Run changed action"));
    await expect(desktop.getByText("Run changed action")).toBeVisible({ timeout: 30_000 });
    await page.locator(".selection-chip").first().getByText("Revalidate").click();
    await expect(page.locator(".selection-chip").first()).toContainText("Stale");
  } finally {
    await writeFile(sourcePath, original);
  }
});
