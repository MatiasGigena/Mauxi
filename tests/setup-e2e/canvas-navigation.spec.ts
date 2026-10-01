import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockDesktop } from "./fixtures";

const board = (page: Page, id = "desktop") => page.locator(`[data-preview-id="${id}"]`);
const preview = (page: Page) => page.frameLocator('[data-testid="desktop-preview"]');
const activate = (page: Page, id = "Desktop") => page.getByRole("button", { name: `Interact with ${id} preview`, exact: true });
const camera = (page: Page) => board(page).evaluate(node => ({ x: (node as HTMLElement).style.left, y: (node as HTMLElement).style.top, zoom: document.querySelector<HTMLInputElement>('[aria-label="Camera zoom"]')!.value }));
const idle = (page: Page) => expect(page.getByTestId("canvas")).toHaveAttribute("data-navigation-gesture", "false");

async function blank(page: Page) {
  const bounds = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.click(bounds.x + 5, bounds.y + 5);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bridge = await readFile("dist-electron/bridge-entry.js", "utf8");
  await page.route("http://127.0.0.1:5173/**", route => {
    if (new URL(route.request().url()).pathname === "/bridge.js") return route.fulfill({ contentType: "text/javascript", body: bridge });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body style="margin:0;height:4000px;background:linear-gradient(white,lightblue)">
      <button id="action" onclick="this.textContent='Actions: '+(++window.actions)">Actions: 0</button>
      <input aria-label="Preview text"><div contenteditable="true" aria-label="Editable text">Edit</div><p id="empty">Preview page</p>
      <script>window.actions=0</script><script type="module" src="/bridge.js"></script></body></html>` });
  });
  await mockDesktop(page);
  await page.evaluate(() => {
    window.mauxi!.bridgeReady = async () => {};
    window.mauxi!.onBrowserState = listener => { (window as any).emitBrowserState = listener; return () => {}; };
  });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
});

test("default pan and pinch work above previews; one click activates without clicking through", async ({ page }) => {
  await expect(activate(page)).toBeVisible();
  const before = await camera(page);
  await activate(page).hover();
  await page.mouse.wheel(30, 45);
  await expect.poll(() => camera(page)).not.toEqual(before);
  await idle(page);
  expect(await preview(page).locator("body").evaluate(() => scrollY)).toBe(0);
  const pan = await camera(page);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -45); await page.keyboard.up("Control");
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(pan.zoom);
  await idle(page);
  await page.getByRole("button", { name: "Fit both", exact: true }).click();
  // The first click lands directly above a page action but must only activate.
  const action = (await preview(page).locator("#action").boundingBox())!;
  await page.mouse.click(action.x + 10, action.y + 5);
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
  await expect(preview(page).locator("#action")).toHaveText("Actions: 0");
  await preview(page).locator("#action").click();
  await expect(preview(page).locator("#action")).toHaveText("Actions: 1");
  const activeCamera = await camera(page);
  await preview(page).locator("#empty").hover(); await page.mouse.wheel(0, 120);
  await expect.poll(() => preview(page).locator("body").evaluate(() => scrollY)).toBeGreaterThan(0);
  expect(await camera(page)).toEqual(activeCamera);
  await blank(page);
  await expect(board(page)).toHaveAttribute("data-interacting", "false");
  await expect(activate(page)).toBeVisible();
});

test("canvas gesture keeps ownership across an already active preview and momentum", async ({ page }) => {
  await activate(page).click();
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
  const bounds = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.move(bounds.x + 5, bounds.y + 5);
  await page.mouse.wheel(0, 12);
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-navigation-gesture", "true");
  const first = await camera(page);
  const frame = (await page.getByTestId("desktop-preview").boundingBox())!;
  await page.mouse.move(frame.x + 100, frame.y + 100);
  for (const delta of [20, 12, 8, 3]) await page.mouse.wheel(0, delta);
  await expect.poll(() => camera(page)).not.toEqual(first);
  expect(await preview(page).locator("body").evaluate(() => scrollY)).toBe(0);
  await idle(page);
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
});

test("Space temporarily pans, restores interaction, and Escape works from inside the frame", async ({ page }) => {
  await activate(page).click();
  await preview(page).locator("#empty").click();
  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas")).toHaveClass(/hand-mode/);
  const before = await camera(page);
  const frame = (await page.getByTestId("desktop-preview").boundingBox())!;
  await page.mouse.move(frame.x + 100, frame.y + 100); await page.mouse.down();
  await page.mouse.move(frame.x + 160, frame.y + 150, { steps: 4 }); await page.mouse.up();
  expect(await camera(page)).not.toEqual(before);
  await page.keyboard.up("Space");
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
  await expect(page.getByTestId("canvas")).not.toHaveClass(/hand-mode/);
  await preview(page).locator("#action").click();
  await page.keyboard.press("Escape");
  await expect(activate(page)).toBeVisible();
  await expect(page.getByTestId("canvas")).toBeFocused();
});

test("typing and keyboard activation keep Space; Escape in an input exits", async ({ page }) => {
  await activate(page).click();
  await preview(page).getByRole("textbox", { name: "Preview text" }).fill("Hello");
  await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("world");
  await expect(preview(page).getByRole("textbox", { name: "Preview text" })).toHaveValue("Hello world");
  await preview(page).locator("#action").focus(); await page.keyboard.press("Space");
  await expect(preview(page).locator("#action")).toHaveText("Actions: 1");
  await preview(page).getByLabel("Editable text").click(); await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("me");
  await expect(preview(page).getByLabel("Editable text")).toHaveText("Edit me");
  await preview(page).getByRole("textbox", { name: "Preview text" }).focus(); await page.keyboard.press("Escape");
  await expect(activate(page)).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Chat");
  await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("draft");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Chat draft");
  await expect(page.getByTestId("canvas")).not.toHaveClass(/hand-mode/);
});

test("pinch in an active preview zooms the camera, and activating another preview deactivates the first", async ({ page }) => {
  await activate(page).click();
  await preview(page).locator("#empty").hover();
  const before = await camera(page);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -30); await page.keyboard.up("Control");
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(before.zoom);
  await idle(page);
  await activate(page, "Mobile").click();
  await expect(board(page, "mobile")).toHaveAttribute("data-interacting", "true");
  await expect(board(page)).toHaveAttribute("data-interacting", "false");
  await expect(page.getByTestId("desktop-preview")).toHaveAttribute("inert", "");
});

test("dragging a passive preview never activates it; hand and picker still work", async ({ page }) => {
  const bounds = (await activate(page).boundingBox())!;
  await page.mouse.move(bounds.x + 100, bounds.y + 100); await page.mouse.down();
  await page.mouse.move(bounds.x + 150, bounds.y + 130, { steps: 4 }); await page.mouse.up();
  await expect(activate(page)).toBeVisible();
  await expect(board(page)).toHaveAttribute("data-interacting", "false");
  await page.getByRole("button", { name: "Hand", exact: true }).click();
  await activate(page).click();
  await expect(board(page)).toHaveAttribute("data-interacting", "false");
  await page.getByRole("button", { name: "Hand on", exact: true }).click();
  await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();
  await expect(page.getByTestId("desktop-preview")).not.toHaveAttribute("inert");
  await preview(page).locator("#empty").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Select in Desktop", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(activate(page)).toBeVisible();
});

test("keyboard activation and Space on blank canvas are accessible", async ({ page }) => {
  await activate(page).focus(); await page.keyboard.press("Enter");
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas")).toHaveClass(/hand-mode/);
  const bounds = (await page.getByTestId("canvas").boundingBox())!;
  await page.mouse.move(bounds.x + 5, bounds.y + 5); await page.mouse.down();
  await page.mouse.move(bounds.x + 30, bounds.y + 30); await page.mouse.up();
  await expect(page.getByTestId("canvas")).toHaveClass(/hand-mode/);
  await page.keyboard.up("Space");
  await expect(page.getByTestId("canvas")).not.toHaveClass(/hand-mode/);
});

test("preview activation and Space release never steal focus back from chat", async ({ page }) => {
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await activate(page).click();
  await editor.fill("Keep chat focus");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Keep chat focus");
  await preview(page).locator("#empty").click();
  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas")).toHaveClass(/hand-mode/);
  await editor.click(); await page.keyboard.up("Space");
  await expect(editor).toBeFocused();
  await page.keyboard.press("End"); await page.keyboard.type(" here");
  await expect(editor).toHaveValue("Keep chat focus here");
});

test("hidden-page cancellation clears held Space and gesture shields", async ({ page }) => {
  await activate(page).click(); await preview(page).locator("#empty").click();
  await page.keyboard.down("Space");
  await expect(page.getByTestId("canvas")).toHaveClass(/hand-mode/);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("canvas")).not.toHaveClass(/hand-mode/);
  await expect(board(page)).toHaveAttribute("data-interacting", "true");
  await page.keyboard.up("Space");
});

test("agent ownership blocks navigation and returns to passive previews", async ({ page }) => {
  await activate(page).click();
  const state = { workspaceId: "test-workspace", generation: 1, owner: "agent", releasing: false, activity: "Testing", remaining: 10, evidence: [] };
  await page.evaluate(state => (window as any).emitBrowserState(state), state);
  await expect(page.locator("[data-browser-shield]")).toHaveCount(2);
  await expect(activate(page)).toHaveCount(0);
  const before = await camera(page);
  await page.getByTestId("canvas").focus();
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
  await page.getByTestId("canvas").dispatchEvent("wheel", { deltaY: 100 });
  expect(await camera(page)).toEqual(before);
  await expect(page.getByTestId("canvas")).not.toHaveClass(/hand-mode/);
  await page.evaluate(state => (window as any).emitBrowserState(state), { ...state, generation: 2, owner: "human" });
  await expect(page.locator("[data-browser-shield]")).toHaveCount(0);
  await expect(activate(page)).toBeVisible();
  await expect(board(page)).toHaveAttribute("data-interacting", "false");
});
