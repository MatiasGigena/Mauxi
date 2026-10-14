import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { BrowserOwner, BrowserState } from "../../src/application/browser-contract";
import type { CanvasState } from "../../src/application/canvas-state";
import { mockDesktop } from "./fixtures";
import { expectRoutes, toggleRoutes } from "../helpers/workspace-controls";

interface CompactControlsTest {
  ownerCalls: Array<{ workspaceId: string; owner: BrowserOwner; shielded: boolean }>;
  saves: CanvasState[];
  closeCalls: number;
  browser: BrowserState;
  browserListener?: (state: BrowserState) => void;
  rejectGrant?: boolean;
  rejectClose?: boolean;
  holdClose?: boolean;
  releaseClose?: () => void;
}

declare global {
  interface Window { compactControlsTest?: CompactControlsTest }
}

async function openWorkspace(page: Page) {
  const bridge = await readFile("dist-electron/bridge-entry.js", "utf8");
  await page.route("http://127.0.0.1:5173/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><input aria-label="Persistent note"><script type="module">${bridge}</script>` }));
  await mockDesktop(page);
  await page.evaluate(() => {
    const setup = window.setupTest!;

    const s: CompactControlsTest = {
      ownerCalls: [], saves: [], closeCalls: 0,
      browser: { workspaceId: "test-workspace", owner: "human", generation: 0, releasing: false, activity: "", remaining: 24, evidence: [] },
    };

    window.compactControlsTest = s;
    window.mauxi!.bridgeReady = async () => {};

    window.mauxi!.saveCanvas = async input => { s.saves.push(input.canvas); };

    window.mauxi!.browserState = async () => s.browser;
    window.mauxi!.onBrowserState = listener => { s.browserListener = listener;

    return () => {}; };

    window.mauxi!.browserOwner = async input => {
      s.ownerCalls.push({ ...input, shielded: [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-testid]")].every(frame => frame.inert && frame.tabIndex === -1 && !!frame.parentElement!.querySelector("[data-browser-shield]")) });

      if (s.rejectGrant && input.owner === "agent") throw new Error("Handoff refused");
      s.browser = { ...s.browser, owner: input.owner, generation: s.browser.generation + 1 };
      s.browserListener!(s.browser);

      return s.browser;
    };

    window.mauxi!.closeProject = async () => {
      s.closeCalls++;

      if (s.rejectClose) throw new Error("Cleanup needs attention");

      if (s.holdClose) await new Promise<void>(resolve => { s.releaseClose = resolve; });
      const event = { active: null, recoveryConflicts: [] };
      setup.workspaceListeners.forEach(listener => listener(event));

      return event;
    };
  });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
}

test("chat grants input-shielded control, unfocuses without remounting and pauses route syncing", async ({ page }) => {
  await openWorkspace(page);
  const desktop = page.frameLocator('[data-testid="desktop-preview"]');
  await page.getByRole("button", { name: "Interact with Desktop preview" }).click();
  await desktop.getByLabel("Persistent note").fill("Keep this value");
  await page.getByRole("button", { name: "Focus Desktop", exact: true }).click();
  await expect(page.getByTestId("mobile-preview")).toBeHidden();
  const grant = page.getByRole("button", { name: "Give agent control", exact: true });
  await expect(grant).toBeEnabled();
  await expect(page.locator(".topbar").getByRole("button", { name: "Give agent control" })).toHaveCount(0);
  await grant.click();
  await expect(page.getByTestId("mobile-preview")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Camera zoom" })).toBeDisabled();
  await expect(page.locator("[data-browser-shield]")).toHaveCount(2);
  await expect(desktop.getByLabel("Persistent note")).toHaveValue("Keep this value");
  expect(await page.evaluate(() => window.compactControlsTest!.ownerCalls.find(call => call.owner === "agent")?.shielded)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.compactControlsTest!.saves.at(-1)?.linked)).toBe(false);
  await page.getByRole("button", { name: "Take back control", exact: true }).click();
  await expect(grant).toBeVisible();
  await expect(page.locator("[data-browser-shield]")).toHaveCount(0);
  await expectRoutes(page, false);
  await toggleRoutes(page, false);
  await expect.poll(() => page.evaluate(() => window.compactControlsTest!.saves.at(-1)?.linked)).toBe(true);
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Link preview routes" })).toHaveAttribute("aria-pressed", "true");
});

test("a denied handoff removes shields and leaves emergency control available during a real grant", async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(() => { window.compactControlsTest!.rejectGrant = true; });
  await page.getByRole("button", { name: "Give agent control", exact: true }).click();
  await expect(page.locator(".workspace-notice")).toContainText("Handoff refused");
  await expect(page.locator("[data-browser-shield]")).toHaveCount(0);
  await page.evaluate(() => { window.compactControlsTest!.rejectGrant = false; });
  await page.getByRole("button", { name: "Give agent control", exact: true }).click();
  await page.getByRole("button", { name: "Models & providers", exact: true }).click();
  await page.getByRole("button", { name: "Emergency take back control", exact: true }).click();
  await expect(page.locator("[data-browser-shield]")).toHaveCount(0);
});

test("the project menu is keyboard accessible and a failed close can be retried", async ({ page }) => {
  await openWorkspace(page);
  const menu = page.getByRole("button", { name: "Project menu" });
  await menu.focus(); await menu.press("ArrowDown");
  const close = page.getByRole("button", { name: "Close project", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused(); await expect(close).toHaveCount(0);
  await menu.click();
  await page.evaluate(() => { window.compactControlsTest!.rejectClose = true; });
  await close.click();
  await expect(page.getByRole("alert")).toHaveText("Cleanup needs attention");
  await expect(close).toBeEnabled();
  await page.evaluate(() => { const s = window.compactControlsTest!; s.rejectClose = false; s.holdClose = true; });
  await close.click();
  await expect(page.getByRole("button", { name: "Closing project…" })).toBeDisabled();
  expect(await page.evaluate(() => window.compactControlsTest!.closeCalls)).toBe(2);
  await page.evaluate(() => window.compactControlsTest!.releaseClose!());
  await expect(page.getByRole("button", { name: "Open Project", exact: true })).toBeVisible();
});

test("route preference can be changed before the bridge connects and grant stays disabled", async ({ page }) => {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeDisabled();
  await toggleRoutes(page, true); await expectRoutes(page, false);
});
