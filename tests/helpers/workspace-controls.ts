import { expect, type Page } from "@playwright/test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BrowserRequest } from "../../src/application/browser-contract";

export const BrowserTargetSchema = Type.Object({ workspaceId: Type.String(), previewId: Type.Union([Type.Literal("desktop"), Type.Literal("mobile")]), documentId: Type.String(), url: Type.String() });

const BrowserIdentitiesSchema = Type.Object({
  state: Type.Object({ owner: Type.Union([Type.Literal("human"), Type.Literal("picker"), Type.Literal("agent")]), generation: Type.Number() }),
  targets: Type.Array(BrowserTargetSchema),
});

const BrowserResultSchema = Type.Object({ text: Type.String(), image: Type.Optional(Type.String()) });

export async function browserIdentities(page: Page) {
  return Value.Parse(BrowserIdentitiesSchema, await page.evaluate(() => window.mauxi!.browserTest("targets")));
}

export async function runBrowser(page: Page, request: BrowserRequest) {
  return Value.Parse(BrowserResultSchema, await page.evaluate(r => window.mauxi!.browserTest(r), request));
}

export async function closeProject(page: Page) {
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("button", { name: "Close project", exact: true }).click();
}

export async function toggleRoutes(page: Page, expected?: boolean) {
  await page.getByRole("button", { name: "Desktop actions", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Desktop actions" });
  const toggle = dialog.getByRole("button", { name: "Link preview routes", exact: true });

  if (expected !== undefined) await expect(toggle).toHaveAttribute("aria-pressed", String(expected));
  await toggle.click();

  if (expected !== undefined) await expect(toggle).toHaveAttribute("aria-pressed", String(!expected));
  await dialog.getByRole("button", { name: "Close actions" }).click();
}

export async function expectRoutes(page: Page, linked: boolean, preview: "Desktop" | "Mobile" = "Desktop") {
  await page.getByRole("button", { name: `${preview} actions`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `${preview} actions` });
  await expect(dialog.getByRole("button", { name: "Link preview routes", exact: true })).toHaveAttribute("aria-pressed", String(linked));
  await dialog.getByRole("button", { name: "Close actions" }).click();
}

async function pan(page: Page, x: number, y: number) {
  const canvas = page.getByTestId("canvas");
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height - 2);
  await page.mouse.wheel(x, y);
  await expect(canvas).toHaveAttribute("data-navigation-gesture", "true");
  await expect.poll(() => canvas.getAttribute("data-navigation-gesture")).toBe("false");
}

export async function fitCanvas(page: Page) {
  const unfocus = page.getByRole("button", { name: /^Unfocus (Desktop|Mobile)$/ });

  if (await unfocus.isVisible()) await unfocus.click();
  const zoom = page.getByRole("slider", { name: "Camera zoom" });

  const fit = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const boards = [...document.querySelectorAll<HTMLElement>(".artboard")].flatMap(node => getComputedStyle(node).visibility === "hidden" ? [] : [node.getBoundingClientRect()]);
    const current = Number(document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value);
    const width = Math.max(...boards.map(r => r.right)) - Math.min(...boards.map(r => r.left));
    const height = Math.max(...boards.map(r => r.bottom)) - Math.min(...boards.map(r => r.top));

    return Math.max(.25, Math.min(2, Math.floor(current * Math.min((canvas.width - 48) / width, (canvas.height - 96) / height) * 100) / 100));
  });

  await zoom.fill(String(fit));

  const delta = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const boards = [...document.querySelectorAll<HTMLElement>(".artboard")].flatMap(node => getComputedStyle(node).visibility === "hidden" ? [] : [node.getBoundingClientRect()]);

    return { x: (Math.min(...boards.map(r => r.left)) + Math.max(...boards.map(r => r.right)) - canvas.left - canvas.right) / 2, y: (Math.min(...boards.map(r => r.top)) + Math.max(...boards.map(r => r.bottom)) - canvas.top - canvas.bottom) / 2 };
  });

  await pan(page, delta.x, delta.y);
}

export async function resetCamera(page: Page, zoom = 1) {
  await page.getByRole("slider", { name: "Camera zoom" }).fill(String(zoom));
  await expect.poll(async () => (await page.getByTestId("desktop-preview").boundingBox())!.width / Number(await page.getByTestId("desktop-preview").getAttribute("width"))).toBeCloseTo(zoom, 4);
  const bounds = (await page.locator('[data-preview-id="desktop"]').boundingBox())!;
  const canvas = (await page.getByTestId("canvas").boundingBox())!;
  await pan(page, bounds.x - canvas.x - 24, bounds.y - canvas.y - 96);
}

export async function selectFixture(page: Page, fixture: "vite" | "next") {
  await expect(page.getByTestId("canvas")).toBeVisible();
  const url = new URL(page.url()); url.searchParams.set("fixture", fixture);
  await page.goto(url.href);
  await expect(page.getByTestId("desktop-preview")).toHaveAttribute("src", new RegExp(`^http://127\\.0\\.0\\.1:${fixture === "next" ? 45000 : 45173}/`));
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
}
