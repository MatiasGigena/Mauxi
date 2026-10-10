import { expect, test, type Page, type FrameLocator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockDesktop } from "./fixtures";

const preview = (page: Page, id = "desktop") => page.frameLocator(`[data-testid="${id}-preview"]`);
const markers = (frame: FrameLocator) => frame.locator("[data-mauxi-selected]");
const chips = (page: Page) => page.locator(".selection-chip");
async function picker(page: Page, label = "Desktop") {
  await page.getByRole("button", { name: `${label} actions`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: `Select in ${label}`, exact: true }).click();
}
async function finishCapture(page: Page, index: number) {
  await page.evaluate(index => (window as any).overlayTest.resolvers[index](), index);
}
async function aligned(frame: FrameLocator, target = "one", index = 0) {
  await expect.poll(async () => {
    const a = await frame.locator(`#${target}`).boundingBox();
    const b = await markers(frame).nth(index).boundingBox();
    return a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) : Infinity;
  }).toBeLessThan(1);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bridge = await readFile("dist-electron/bridge-entry.js", "utf8");
  await page.route("http://127.0.0.1:5173/**", route => {
    if (new URL(route.request().url()).pathname === "/bridge.js") return route.fulfill({ contentType: "text/javascript", body: bridge });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>
      body { margin:0; padding:80px 24px; min-height:2400px; background:#fafaf9; font:16px system-ui; }
      h1 { margin:0 0 24px; font-size:28px; }
      button { display:block; width:260px; height:100px; margin:0 0 24px; border:1px solid #e8e5e1; border-radius:16px; background:white; color:#24242a; }
      div { background:red !important; color:red !important; border:12px solid red !important; }
    </style></head><body><h1>Selection preview</h1>
      ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].map(id => `<button id="${id}" onclick="window.actions++">Target ${id}</button>`).join("")}
      <script>window.actions=0</script><script type="module" src="/bridge.js"></script></body></html>` });
  });
  await page.exposeFunction("inspectCaptureChrome", async (id: string) => {
    // The real bridge must already have hidden both hover and persistent chrome
    // when the shell calls the trusted capture host.
    const frame = preview(page, id);
    return {
      hover: await frame.locator("[data-mauxi-hover]").isVisible(),
      markers: await markers(frame).evaluateAll(nodes => nodes.some(node => getComputedStyle(node).visibility !== "hidden" && !(node as HTMLElement).hidden)),
    };
  });
  await mockDesktop(page);
  await page.evaluate(() => {
    const state = (window as any).overlayTest = { hold: false, fail: false, captures: [] as unknown[], resolvers: [] as Array<() => void>, released: [] as string[], accept: true, sent: [] as unknown[] };
    window.addEventListener("message", event => { if (event.data?.kind === "selection") (state as any).lastSelection = event.data; });
    window.mauxi!.onBrowserState = listener => { (state as any).browserState = listener; return () => {}; };
    window.mauxi!.bridgeReady = async () => {};
    window.mauxi!.capturePreview = async request => {
      const chrome = await (window as any).inspectCaptureChrome(request.previewId);
      const index = state.captures.length;
      state.captures.push({ request, chrome });
      if (state.hold) await new Promise<void>(resolve => { state.resolvers[index] = resolve; });
      if (state.fail) throw new Error("Synthetic capture failure");
      return { path: `/test-capture-${index}.png`, width: 100, height: 100 };
    };
    window.mauxi!.releaseCaptures = async paths => { state.released.push(...paths); };
    window.mauxi!.agentSend = async request => { state.sent.push(request); return { accepted: state.accept }; };
  });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
  await page.evaluate(() => {
    const snapshot = {
      ready: true, workspaceId: "test-workspace", sessionId: "session", providers: [],
      models: [{ key: "fake/one", name: "Fake", provider: "fake", id: "one", available: true, supportsImages: true, thinkingLevels: ["off"] }],
      selectedModel: "fake/one", sessions: [], messages: [], tools: [], changeSets: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
    };
    (window as any).setupTest.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "snapshot", snapshot }));
  });
});

test("teal hover chrome is isolated from page CSS and labels stay inside the viewport", async ({ page }, testInfo) => {
  const frame = preview(page);
  await picker(page);
  await frame.locator("#one").hover();
  const outline = frame.locator("[data-mauxi-hover]");
  const label = frame.locator("[data-mauxi-picker-label]");
  await expect(outline).toBeVisible();
  await expect(outline).toHaveCSS("border-top-color", "rgb(33, 143, 144)");
  await expect(outline).toHaveCSS("background-color", "rgba(33, 143, 144, 0.04)");
  await expect(label).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(label).toContainText("button");
  await expect(label).toContainText("260 × 100");
  await expect(label).toContainText("Enter attach");
  await page.screenshot({ path: testInfo.outputPath("teal-selector.png") });
  await frame.locator("#one").click();
  await expect(markers(frame)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outline).toBeHidden();
  await expect(markers(frame)).toBeVisible();
  await expect(markers(frame)).toHaveCSS("border-top-color", "rgb(20, 122, 122)");
  await expect(markers(frame)).toContainText("Selected");
  await page.screenshot({ path: testInfo.outputPath("persistent-selection.png") });
  // Narrow mobile viewport and a target touching its bottom/right edge.
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("240");
  await page.getByRole("button", { name: "Apply viewport", exact: true }).click();
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Focus Mobile", exact: true }).click();
  await page.getByRole("slider", { name: "Camera zoom" }).fill("0.5");
  await picker(page, "Mobile");
  const mobile = preview(page, "mobile");
  await mobile.locator("#one").evaluate(node => { (node as HTMLElement).style.cssText = "position:fixed;right:0;bottom:0;width:100px;height:40px;margin:0"; });
  await mobile.locator("#one").hover();
  expect(await mobile.locator("[data-mauxi-picker-label]").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  })).toBe(true);
});

test("draft marks follow scrolling, layout and zoom; removal never clicks through", async ({ page }) => {
  const frame = preview(page);
  await picker(page);
  await frame.locator("#one").click();
  await frame.locator("#two").click();
  await expect(markers(frame)).toHaveCount(2);
  await expect(markers(frame).first()).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await frame.locator("body").evaluate(() => (window as any).actions)).toBe(0);
  await aligned(frame);
  await frame.locator("body").evaluate(() => scrollTo(0, 80));
  await aligned(frame);
  await frame.locator("#one").evaluate(node => { (node as HTMLElement).style.transform = "translate(40px, 20px)"; });
  await aligned(frame);
  await page.getByRole("slider", { name: "Camera zoom" }).fill("0.25");
  await aligned(frame);
  await page.getByRole("button", { name: "Remove selection Target one", exact: true }).click();
  await expect(markers(frame)).toHaveCount(1);
  await aligned(frame, "two");
  await page.getByRole("button", { name: "Remove selection Target two", exact: true }).click();
  await expect(markers(frame)).toHaveCount(0);
});

test("navigation and removed instances clear markers without transferring them to replacements", async ({ page }) => {
  await page.getByRole("button", { name: "Routes linked", exact: true }).click();
  const frame = preview(page);
  await picker(page); await frame.locator("#one").click();
  await expect(markers(frame)).toBeVisible();
  await page.keyboard.press("Escape");
  await frame.locator("#one").evaluate(node => node.replaceWith(node.cloneNode(true)));
  await expect(markers(frame)).toHaveCount(0);
  await picker(page); await frame.locator("#two").click();
  await expect(markers(frame)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Focus Mobile", exact: true }).click();
  await picker(page, "Mobile"); await preview(page, "mobile").locator("#one").click();
  await expect(markers(preview(page, "mobile"))).toBeVisible();
  await frame.locator("body").evaluate(() => history.pushState({}, "", "/changed"));
  await expect(markers(frame)).toHaveCount(0);
  await expect(markers(preview(page, "mobile"))).toBeVisible();
  await expect(chips(page).filter({ hasText: "Target two" })).toHaveClass(/stale/);
  await preview(page, "mobile").locator("body").evaluate(() => location.reload());
  await expect(markers(preview(page, "mobile"))).toHaveCount(0);
  await expect(page.locator('.selection-chip[data-selection-preview="mobile"]')).toHaveClass(/stale/);
});

test("overlapping captures hide all chrome until the last capture ends, including failures and removals", async ({ page }) => {
  const frame = preview(page);
  await page.evaluate(() => { (window as any).overlayTest.hold = true; });
  await picker(page); await frame.locator("#one").click(); await frame.locator("#two").click();
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.captures.length)).toBe(2);
  await expect(markers(frame)).toHaveCount(2);
  await expect(markers(frame).first()).toBeHidden();
  await finishCapture(page, 0);
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.captures[0].chrome)).toEqual({ hover: false, markers: false });
  await expect(markers(frame).first()).toBeHidden();
  await finishCapture(page, 1);
  await expect(markers(frame).first()).toBeVisible();
  await frame.locator("#three").click();
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.captures.length)).toBe(3);
  await page.getByRole("button", { name: "Remove selection Target three", exact: true }).click();
  await finishCapture(page, 2);
  await expect(markers(frame)).toHaveCount(2);
  await expect(markers(frame).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.released)).toContain("/test-capture-2.png");
  await page.evaluate(() => { (window as any).overlayTest.hold = false; (window as any).overlayTest.fail = true; });
  await frame.locator("#three").click();
  await expect(markers(frame)).toHaveCount(3);
  await expect(markers(frame).last()).toBeVisible();
  expect(await page.evaluate(() => (window as any).overlayTest.captures.every((capture: any) => !capture.chrome.hover && !capture.chrome.markers))).toBe(true);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).overlayTest.fail = false; });
  await page.getByRole("button", { name: "Desktop actions", exact: true }).click();
  await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.captures.length)).toBe(5);
  expect(await page.evaluate(() => (window as any).overlayTest.captures[4].chrome)).toEqual({ hover: false, markers: false });
  await expect(markers(frame).first()).toBeVisible();
});

test("duplicate picks share a marker and draft eviction removes old markers", async ({ page }) => {
  const frame = preview(page);
  await page.getByRole("slider", { name: "Camera zoom" }).fill("0.5");
  await picker(page); await frame.locator("#one").click(); await frame.locator("#one").click();
  await expect(chips(page)).toHaveCount(2);
  await expect(markers(frame)).toHaveCount(1);
  await chips(page).first().getByRole("button").click();
  await expect(markers(frame)).toHaveCount(1);
  for (const id of ["two", "three", "four", "five", "six", "seven", "eight", "nine"]) await frame.locator(`#${id}`).click();
  await expect(chips(page)).toHaveCount(8);
  await expect(markers(frame)).toHaveCount(8);
  await expect(chips(page).filter({ hasText: "Target one" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 8; i++) await chips(page).first().getByRole("button").click();
  await expect(markers(frame)).toHaveCount(0);
});

test("stale bridge messages cannot clear marks and browser ownership hides them temporarily", async ({ page }) => {
  const frame = preview(page);
  await picker(page); await frame.locator("#one").click();
  await expect(markers(frame)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const state = (window as any).overlayTest;
    const target = document.querySelector<HTMLIFrameElement>('[data-testid="desktop-preview"]')!.contentWindow!;
    for (const invalid of [{ generation: "old-document" }, { session: "other-workspace" }]) {
      target.postMessage({ ...state.lastSelection, ...invalid, kind: "selection-markers", selectionIds: [] }, "http://127.0.0.1:5173");
    }
  });
  await expect(markers(frame)).toBeVisible();
  const state = { workspaceId: "test-workspace", generation: 1, owner: "agent", releasing: false, activity: "Testing", remaining: 10, evidence: [] };
  await page.evaluate(state => (window as any).overlayTest.browserState(state), state);
  await expect(markers(frame)).toHaveCount(0);
  await expect(chips(page)).toHaveCount(1);
  await page.evaluate(state => (window as any).overlayTest.browserState(state), { ...state, generation: 2, owner: "human" });
  await expect(markers(frame)).toBeVisible();
});

test("keyboard attachment stays marked on rejected send and clears only after acceptance", async ({ page }) => {
  const frame = preview(page);
  await picker(page); await frame.locator("#one").hover(); await page.keyboard.press("Enter");
  await expect(markers(frame)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).overlayTest.accept = false; });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Polish this button");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).overlayTest.sent.length)).toBe(1);
  await expect(markers(frame)).toBeVisible();
  await expect(chips(page)).toHaveCount(1);
  await page.evaluate(() => { (window as any).overlayTest.accept = true; });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(markers(frame)).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
});
