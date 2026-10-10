import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { latestSelection, observeSelections, revalidateSelection } from "../helpers/selection-evidence";

let application: ElectronApplication;
let page: Page;
const desktop = () => page.frameLocator('[data-testid="desktop-preview"]');
const mobile = () => page.frameLocator('[data-testid="mobile-preview"]');
const button = (name: string) => page.getByRole("button", { name, exact: true });

test.beforeAll(async ({}, testInfo) => {
  application = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", MAUXI_EVIDENCE_DIR: testInfo.outputPath("captures"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173" } });
  page = await application.firstWindow();
});
test.afterAll(async () => { await application?.close(); });
test.beforeEach(async () => { await page.reload(); await expect(page.locator(".bridge-ready")).toHaveCount(2); await observeSelections(page); await button("Interact with Desktop preview").click(); });

async function route(side: "desktop" | "mobile") {
  const owner = await page.getByTestId(`${side}-preview`).elementHandle();
  const frame = await owner!.contentFrame();
  await owner!.dispose();
  // Navigation can destroy the page's execution context between polling calls.
  const url = new URL(frame!.url());
  return url.pathname + url.search + url.hash;
}
async function actions(side = "Desktop") { await button(`${side} actions`).click(); }

test("real viewport breakpoints, focus instance/form persistence, keyboard access and chat", async () => {
  await desktop().getByLabel("Persistent note").fill("Do not remount this form");
  const marker = await desktop().locator("body").evaluate(() => { const id = crypto.randomUUID(); document.body.dataset.instance = id; return id; });
  const before = await page.locator('[data-preview-id="desktop"]').boundingBox();
  await button("Focus Desktop").click();
  await expect(page.getByTestId("mobile-preview")).not.toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Focus leaves chat reachable.");
  // Proof mode has no project/model and must never simulate a completed agent request.
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Focus leaves chat reachable.");
  await expect(button("Send")).toBeDisabled();
  await button("Unfocus Desktop").click();
  expect(await page.locator('[data-preview-id="desktop"]').boundingBox()).toEqual(before);
  await expect(desktop().getByLabel("Persistent note")).toHaveValue("Do not remount this form");
  expect(await desktop().locator("body").getAttribute("data-instance")).toBe(marker);
  for (const zoom of ["0.25", "0.5", "1", "2"]) {
    await page.getByLabel("Camera zoom").fill(zoom);
    expect(await desktop().locator("body").evaluate(() => [innerWidth, innerHeight, matchMedia("(max-width: 600px)").matches])).toEqual([1440, 900, false]);
    expect(await mobile().locator("body").evaluate(() => [innerWidth, innerHeight, matchMedia("(max-width: 600px)").matches])).toEqual([390, 844, true]);
    await page.getByLabel("Message", { exact: true }).fill(`Typing at ${zoom}`);
    expect(await page.getByLabel("Message", { exact: true }).evaluate((node) => getComputedStyle(node).fontSize)).toBe("14px");
  }
  await button("Fit both").click();
  await actions("Mobile");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(button("Close actions")).toBeFocused();
  await page.getByLabel("Width", { exact: true }).fill("720");
  await button("Apply viewport").click();
  expect(await mobile().locator("body").evaluate(() => [innerWidth, matchMedia("(max-width: 600px)").matches])).toEqual([720, false]);
  await actions("Mobile"); await page.keyboard.press("Escape");
  await expect(button("Mobile actions")).toBeFocused();
  await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveCount(0);
  const dock = await page.locator(".chat-dock").boundingBox();
  const surface = await page.locator(".canvas-surface").boundingBox();
  expect(dock!.x).toBeGreaterThan(surface!.x);
  expect(dock!.x + dock!.width).toBeLessThan(surface!.x + surface!.width);
  expect(dock!.y + dock!.height).toBeLessThan(surface!.y + surface!.height);
  expect((await page.getByLabel("Message", { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await button("Hand").click();
  await page.getByLabel("Message", { exact: true }).fill("Typing does not pan the canvas.");
  await page.getByLabel("Message", { exact: true }).press("ArrowLeft");
  expect(await page.locator(".chat-dock").boundingBox()).toEqual(dock);
  await button("Hand on").click();
});

test("1:1 header dragging, pointer cancellation, independent wheel and hand/selection input", async () => {
  const board = page.locator('[data-preview-id="desktop"]');
  for (const zoom of [.25, .5, 1, 2]) {
    await button("Reset").click();
    const bounds = await page.getByTestId("canvas").boundingBox();
    await page.mouse.move(5, bounds!.y + 5);
    await page.keyboard.down("Control"); await page.mouse.wheel(0, Math.log(1 / zoom) / .005); await page.keyboard.up("Control");
    await expect.poll(async () => Number(await page.getByLabel("Camera zoom").inputValue())).toBeCloseTo(zoom, 2);
    const before = await board.boundingBox(); const grip = await board.locator(".board-grip").boundingBox();
    await page.mouse.move(grip!.x + 10, grip!.y + 10); await page.mouse.down();
    await page.mouse.move(grip!.x + 47, grip!.y + 39); await page.mouse.up();
    const after = await board.boundingBox();
    expect(after!.x - before!.x).toBeCloseTo(37, 0); expect(after!.y - before!.y).toBeCloseTo(29, 0);
  }
  await button("Fit both").click();
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-navigation-gesture", "false");
  await desktop().locator("body").evaluate(() => scrollTo(0, 0));
  const frame = await page.getByTestId("desktop-preview").boundingBox();
  await page.mouse.move(frame!.x + 100, frame!.y + 100); await page.mouse.wheel(0, 220);
  await expect.poll(() => desktop().locator("body").evaluate(() => scrollY)).toBeGreaterThan(0);
  expect(await mobile().locator("body").evaluate(() => scrollY)).toBe(0);
  await button("Hand").click();
  const scrollBefore = await desktop().locator("body").evaluate(() => scrollY);
  const before = await board.boundingBox();
  await page.mouse.move(frame!.x + 100, frame!.y + 100); await page.mouse.down(); await page.mouse.move(frame!.x + 143, frame!.y + 125); await page.mouse.up();
  const after = await board.boundingBox(); expect(after!.x - before!.x).toBeCloseTo(43, 0);
  await page.mouse.wheel(0, 80);
  expect(await desktop().locator("body").evaluate(() => scrollY)).toBe(scrollBefore);
  await expect(desktop().getByTestId("click-count")).toContainText("0");
  await button("Hand on").click(); await button("Fit both").click();
  await button("Select in Desktop").click();
  await desktop().getByTestId("known-target").click();
  await expect(desktop().getByTestId("click-count")).toContainText("0");
  await expect(page.locator(".selection-chip")).toHaveCount(1);
  await desktop().getByRole("button", { name: "Submit once" }).focus(); await page.keyboard.press("Enter");
  await expect(desktop().getByTestId("submit-count")).toHaveText("Submissions: 0");
  await page.keyboard.press("Escape");
  await expect(button("Select in Desktop")).toHaveAttribute("aria-pressed", "false");
  // Pointer cancellation removes transient shielding, leaving the inactive peer shielded.
  await button("Interact with Desktop preview").click();
  const grip = await board.locator(".board-grip").boundingBox();
  await page.mouse.move(grip!.x + 10, grip!.y + 10); await page.mouse.down();
  await page.mouse.move(grip!.x + 15, grip!.y + 15);
  await expect(page.locator(".input-shield")).toHaveCount(2);
  await board.locator(".board-grip").dispatchEvent("pointercancel", { pointerId: 1 });
  await expect(page.locator(".input-shield")).toHaveCount(1);
  await expect(board).toHaveAttribute("data-interacting", "true");
  const cancelled = await board.boundingBox();
  await page.mouse.move(grip!.x + 80, grip!.y + 30); await page.mouse.up();
  expect(await board.boundingBox()).toEqual(cancelled);
});

test("picker refinement, scaled targets, instance identity, overlap and redaction", async () => {
  const target = desktop().getByTestId("known-icon");
  await button("Select in Desktop").click();
  for (const zoom of ["0.25", "0.5", "1", "2"]) {
    await page.getByLabel("Camera zoom").fill(zoom);
    const targetBounds = await target.boundingBox();
    const canvasBounds = await page.getByTestId("canvas").boundingBox();
    if (!targetBounds || !canvasBounds) throw new Error("Target geometry unavailable");
    await page.getByTestId("canvas").dispatchEvent("wheel", {
      deltaX: targetBounds.x + targetBounds.width / 2 - (canvasBounds.x + canvasBounds.width / 2),
      deltaY: targetBounds.y + targetBounds.height / 2 - (canvasBounds.y + canvasBounds.height / 2),
    });
    await expect(page.getByTestId("canvas")).toHaveAttribute("data-navigation-gesture", "false");
    await target.click();
    await expect(desktop().getByTestId("click-count")).toContainText("0");
    await expect(page.locator(".selection-chip")).toHaveCount(1);
    await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();
  }
  await page.getByLabel("Camera zoom").fill("0.5");
  await button("Select in Desktop").click();

  await button("Fit both").click();
  await button("Select in Desktop").click();
  await target.hover();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const refinedChip = page.locator(".selection-chip").first();
  await expect(refinedChip).toContainText("Increment proof counter");
  const refined = await latestSelection(page);
  expect(refined.domAncestry.some(entry => entry.tag === "button")).toBe(true);
  expect(refined.componentOwners.some(owner => owner.componentName === "ProofCard")).toBe(true);
  expect(refined.componentOwners.some(owner => owner.componentName === "path")).toBe(false);
  await expect(refinedChip.getByRole("button")).toHaveCount(1);
  await expect(desktop().getByTestId("click-count")).toContainText("0");
  await button("Select in Desktop").click();
  await refinedChip.getByRole("button", { name: /Remove selection/ }).click();

  await button("Select in Desktop").click();
  await desktop().getByTestId("overlap-front").hover();
  await page.keyboard.press("]");
  await page.keyboard.press("Enter");
  await expect(page.locator(".selection-chip").first()).toContainText("Back layer");
  await button("Select in Desktop").click();
  await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();

  // Keep the fixed bottom portal above the floating chat dock.
  await page.getByLabel("Camera zoom").fill("0.5");
  for (const fixtureTarget of ["scrolled-target", "viewport", "portal-target"] as const) {
    await button("Select in Desktop").click();
    await desktop().getByTestId(fixtureTarget).click();
    await expect(page.locator(".selection-chip")).toHaveCount(1);
    await button("Select in Desktop").click();
    await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();
  }
  await button("Select in Desktop").click();
  await desktop().getByTestId("unsupported-canvas").click();
  const unsupported = await latestSelection(page);
  expect(unsupported.support.status).toBe("unsupported");
  expect(unsupported.support.reason).toContain("Canvas/WebGL pixels");
  await button("Select in Desktop").click();
  await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();

  await desktop().getByTestId("same-origin-frame").scrollIntoViewIfNeeded();
  await button("Select in Desktop").click();
  await expect(desktop().locator('[data-mauxi-frame-target="same-origin-frame"]')).toBeVisible();
  const childFrame = await desktop().getByTestId("same-origin-frame").boundingBox();
  if (!childFrame) throw new Error("Child-frame geometry unavailable");
  await page.mouse.click(childFrame.x + childFrame.width / 2, childFrame.y + childFrame.height / 2);
  await expect(page.locator(".selection-chip").first()).toContainText("Same-origin child frame fixture");
  expect(await desktop().locator("body").getAttribute("data-child-clicks")).toBeNull();
  await button("Select in Desktop").click();
  await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();

  await button("Select in Desktop").click();
  await desktop().getByTestId("identity-alpha").click();
  await button("Select in Desktop").click();
  await desktop().getByRole("button", { name: "Reorder retained items" }).click();
  expect(await revalidateSelection(page)).toBe("valid");
  await expect(page.locator(".selection-chip").first()).toHaveClass(/current/);
  await desktop().getByRole("button", { name: "Remount identical items" }).click();
  expect(await revalidateSelection(page)).toBe("stale");
  await expect(page.locator(".selection-chip").first()).toHaveClass(/stale/);
  await page.getByLabel("Message", { exact: true }).fill("Do not send stale context");
  await expect(button("Send")).toBeDisabled();
  await expect(page.locator(".selection-chip").first()).toHaveClass(/stale/);
  await expect(page.getByRole("log")).toHaveCount(0);
  await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();

  const secret = "never-serialize-this-value";
  await desktop().getByLabel("Persistent note").fill(secret);
  await desktop().getByTestId("editable-secret").fill(secret);
  await desktop().getByLabel("Private textarea").fill(secret);
  await button("Select in Desktop").click();
  await desktop().getByLabel("Persistent note").click();
  let chip = page.locator(".selection-chip").first();
  const inputCapture = await latestSelection(page);
  expect(inputCapture.screenshot.crop).toBeDefined();
  expect(JSON.stringify(inputCapture)).not.toContain(secret);
  expect(JSON.stringify(inputCapture)).toContain("[redacted input]");
  await chip.getByRole("button", { name: /Remove selection/ }).click();

  await desktop().getByTestId("editable-secret").click();
  chip = page.locator(".selection-chip").first();
  const editableCapture = await latestSelection(page);
  expect(JSON.stringify(editableCapture)).not.toContain(secret);
  expect(JSON.stringify(editableCapture)).toContain("[redacted input]");
  await chip.getByRole("button", { name: /Remove selection/ }).click();

  // Removing the final badge intentionally returns focus to the editor.
  // Move focus back to the canvas before using picker keyboard shortcuts.
  await page.getByTestId("canvas").focus();
  await desktop().getByTestId("sensitive-parent-label").hover();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const parentCapture = await latestSelection(page);
  expect(JSON.stringify(parentCapture)).not.toContain(secret);
  expect(JSON.stringify(parentCapture)).toContain("[redacted input]");
});

test("linked client/document routes arrive once; unlink/copy, POST and auth isolation", async () => {
  const navigations: string[] = [];
  const peerFrame = page.frames().find((frame) => frame.url().includes("mauxiPreview=mobile"));
  page.on("framenavigated", (frame) => { if (frame === peerFrame) navigations.push(frame.url()); });
  await desktop().getByRole("link", { name: "Client route", exact: true }).click();
  await expect.poll(() => route("mobile")).toBe("/details?view=wide#overview");
  expect(navigations.filter((url) => url.endsWith("/details?view=wide#overview"))).toHaveLength(1);
  expect(await mobile().locator("body").evaluate(() => history.state)).toBeNull();
  await expect(page.locator(".bridge-ready")).toHaveCount(2);
  await button("Routes linked").click();
  await desktop().getByRole("link", { name: "Document route", exact: true }).click();
  await expect.poll(() => route("desktop")).toBe("/document");
  expect(await route("mobile")).toBe("/details?view=wide#overview");
  await actions(); await button("Copy route to mobile").click();
  await expect.poll(() => route("mobile")).toBe("/document");
  await button("Routes unlinked").click();
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/side-effect")) posts.push(request.url()); });
  await desktop().getByRole("button", { name: "Submit once", exact: true }).click();
  await expect(desktop().getByTestId("submit-count")).toHaveText("Submissions: 1");
  await expect.poll(() => posts.length).toBe(1);
  await expect(mobile().getByTestId("submit-count")).toHaveText("Submissions: 0");
  expect(await route("mobile")).toBe("/document");
  await desktop().getByRole("link", { name: "Auth callback", exact: true }).click();
  await expect.poll(() => route("desktop")).toBe("/auth/callback?code=private");
  expect(await route("mobile")).toBe("/document");
  await actions(); await expect(button("Copy route to mobile")).toBeDisabled(); await button("Close actions").click();
  await desktop().getByRole("link", { name: "External route", exact: true }).click();
  expect(await route("desktop")).toBe("/auth/callback?code=private");
  await expect(page.locator(".connection [role=status]")).toContainText("External navigation blocked");
  await desktop().getByRole("link", { name: "Document route", exact: true }).click();
  await desktop().getByRole("link", { name: "Client route", exact: true }).click();
  await expect.poll(() => route("mobile")).toBe("/details?view=wide#overview");
});

for (const submission of [
  { control: "Native submit()", destination: "/native-result?choice=one" },
  { control: "Request submit", destination: "/native-result?choice=one" },
  { control: "Native form", destination: "/native-result?choice=one" },
  { control: "Submit once", destination: "/submitted" },
]) {
  test(`${submission.control}: excludes the form route, then resumes independent router navigation`, async () => {
    const source = page.frames().find((frame) => frame.url().includes("mauxiPreview=desktop"))!;
    const peer = page.frames().find((frame) => frame.url().includes("mauxiPreview=mobile"))!;
    const initialPeerUrl = peer.url();
    const requests: string[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      if (request.isNavigationRequest() && new URL(request.url()).pathname === "/native-result") requests.push(request.url());
    };
    page.on("request", onRequest);
    try {
      await desktop().getByRole("button", { name: submission.control, exact: true }).click();
      await expect.poll(() => source.url()).toBe(`http://127.0.0.1:45173${submission.destination}`);
      await expect(page.locator(".bridge-ready")).toHaveCount(2);
      // Framework hydration often writes same-URL history state. It must not
      // consume a pending marker or make a form destination copyable again.
      await desktop().locator("body").evaluate(() => history.replaceState({ hydrated: true }, "", location.href));
      await actions(); await expect(button("Copy route to mobile")).toBeDisabled(); await button("Close actions").click();
      expect(peer.url()).toBe(initialPeerUrl);
      if (submission.destination.startsWith("/native-result")) expect(requests).toHaveLength(1);
      await desktop().getByRole("button", { name: "Independent router navigation", exact: true }).click();
      await expect.poll(() => peer.url()).toBe("http://127.0.0.1:45173/after-form");
      expect(source.url()).toBe("http://127.0.0.1:45173/after-form");
    } finally { page.off("request", onRequest); }
  });
}

test("SPA route changes invalidate only that preview's selections and require a fresh pick", async () => {
  await button("Routes linked").click();
  for (const side of ["Mobile", "Desktop"]) {
    await button(`Select in ${side}`).click();
    await (side === "Desktop" ? desktop() : mobile()).getByTestId("known-target").click();
    await expect(page.locator(".selection-chip")).toHaveCount(side === "Desktop" ? 2 : 1);
  }
  await button("Select in Desktop").click();
  const sourceChip = page.locator('.selection-chip[data-selection-preview="desktop"]');
  const peerChip = page.locator('.selection-chip[data-selection-preview="mobile"]');
  const marker = await desktop().locator("body").evaluate(() => {
    document.body.dataset.instance = crypto.randomUUID();
    history.replaceState({ local: true }, "", location.href);
    return document.body.dataset.instance;
  });
  await expect(sourceChip).toHaveClass(/current/);
  await desktop().locator("body").evaluate(() => history.pushState(null, "", "/different-page"));
  await expect(sourceChip).toHaveClass(/stale/);
  await expect(sourceChip).toHaveAttribute("title", /Select again before sending/);
  await expect(peerChip).toHaveClass(/current/);
  expect(await desktop().locator("body").getAttribute("data-instance")).toBe(marker);
  // Matching controls on the new route (or navigating back) must not make an
  // attachment from the old rendered page current again.
  await desktop().locator("body").evaluate(() => history.back());
  await expect(sourceChip).toHaveClass(/stale/);
  await button("Select in Desktop").click();
  await desktop().getByTestId("known-target").click();
  await expect(page.locator(".selection-chip")).toHaveCount(3);
  await expect(page.locator(".selection-chip").first()).toHaveClass(/current/);
  await button("Select in Desktop").click();
  await desktop().locator("body").evaluate(() => location.hash = "another-view");
  await expect(page.locator(".selection-chip").first()).toHaveClass(/stale/);
  await expect(peerChip).toHaveClass(/current/);
});

test("readable text, reduced motion, immediate feedback and minimal resting composition", async ({}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
  await page.evaluate(() => document.documentElement.style.fontSize = "20px");
  await button("Fit both").click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator(".artboard-actions button")).toHaveCount(6);
  await page.getByLabel("Message", { exact: true }).fill("Keyboard text stays in chat: + - 0 f h");
  expect(await page.getByLabel("Message", { exact: true }).evaluate((node) => getComputedStyle(node).fontSize)).toBe("17.5px");
  const focus = button("Focus Desktop");
  await focus.hover();
  await expect(focus).toHaveCSS("color", "rgb(185, 78, 56)");
  await page.mouse.down();
  await expect(focus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await focus.evaluate(node => node.matches(":active"))).toBe(true);
  await page.mouse.up(); await button("Unfocus Desktop").click(); await button("Focus Desktop").click(); await button("Unfocus Desktop").click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keyboard text stays in chat: + - 0 f h");
  await page.screenshot({ path: testInfo.outputPath("large-text-reduced-motion.png") });
  await page.evaluate(() => document.documentElement.style.fontSize = "16px");
  await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
  await button("Fit both").click();
  await page.screenshot({ path: testInfo.outputPath("workspace.png") });
  await actions();
  await expect(page.getByText("Preview diagnostics", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("actions.png") });
});
