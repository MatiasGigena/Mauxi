import { expect, test, type Page } from "@playwright/test";
import { canvasTrailGeometry } from "../../src/presentation/canvas-background";
import { mockDesktop } from "./fixtures";

async function openWorkspace(page: Page) {
  await mockDesktop(page);
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  await expect(page.getByTestId("canvas")).toBeVisible();
}

async function assertInitialRouteNearViews(page: Page) {
  const measured = await page.locator(".canvas-surface").evaluate(surface => {
    const origin = surface.getBoundingClientRect();
    return { width: origin.width, height: origin.height, views: [...surface.querySelectorAll<HTMLElement>(".artboard")]
      .filter(board => getComputedStyle(board).visibility !== "hidden")
      .map(board => { const rect = board.getBoundingClientRect(); return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }; }) };
  });
  const expected = canvasTrailGeometry(measured.width, measured.height, measured.views)?.edges.map(({ x, y, length }) => ({ x, y, length })) ?? [];
  await expect.poll(() => page.locator(".canvas-trail-edge").evaluateAll(edges => edges.map(el => {
    const edge = el as HTMLElement;
    const transform = new DOMMatrix(edge.style.transform);
    return { x: transform.m41, y: transform.m42, length: parseFloat(edge.style.width) };
  }))).toEqual(expected);
  return expected;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 768, height: 800 }, { width: 390, height: 800 }]) {
  test(`white grid, soft shadows and working canvas at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openWorkspace(page);
    await expect(page.locator(".canvas-background")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    expect(await page.locator(".canvas-background").evaluate(el => getComputedStyle(el, "::before").maskSize)).toBe("320px 320px, 320px 320px");
    await expect(page.getByRole("button", { name: /Pause.*animation/i })).toHaveCount(0);
    await expect.poll(() => page.locator(".canvas-trail-strip").count()).toBeGreaterThanOrEqual(4);
    await assertInitialRouteNearViews(page);
    const motion = await page.locator(".canvas-trail").evaluate(el => {
      const animation = el.getAnimations({ subtree: true })[0];
      const strip = el.querySelector<HTMLElement>(".canvas-trail-strip")!;
      const length = [...el.querySelectorAll<HTMLElement>(".canvas-trail-edge")].reduce((sum, edge) => sum + parseFloat(edge.style.width), 0);
      return { width: parseFloat(strip.style.width), speed: length / (Number(animation.effect!.getTiming().duration) / 1000), easing: animation.effect!.getTiming().easing };
    });
    expect(motion.width).toBe(240); expect(motion.speed).toBeCloseTo(140); expect(motion.easing).toBe("linear");
    for (const selector of [".preview-surface", ".chat-surface"]) {
      expect(await page.locator(selector).first().evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
    }
    const canvas = page.getByTestId("canvas");
    const original = await canvas.boundingBox();
    await page.evaluate(() => { (window as any).originalTrail = document.querySelector(".canvas-trail")!.getAnimations({ subtree: true })[0]; });
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft");
    expect(await page.evaluate(() => (window as any).originalTrail === document.querySelector(".canvas-trail")!.getAnimations({ subtree: true })[0])).toBe(true);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(await page.evaluate(() => (window as any).originalTrail === document.querySelector(".canvas-trail")!.getAnimations({ subtree: true })[0])).toBe(true);
    await page.getByRole("button", { name: "Fit both", exact: true }).click();
    expect(await canvas.boundingBox()).toEqual(original);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this draft");
    expect(await canvas.evaluate(node => node.contains(document.elementFromPoint(5, innerHeight - 5)))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("white-canvas.png") });
    expect(errors).toEqual([]);
  });
}

test("trail never reroutes or restarts during zoom, movement, focus or pan", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openWorkspace(page);
  await expect.poll(() => page.locator(".canvas-trail-strip").count()).toBeGreaterThanOrEqual(4);
  await assertInitialRouteNearViews(page);
  await page.evaluate(() => {
    const trail = document.querySelector(".canvas-trail")!;
    (window as any).initialTrail = {
      edges: [...trail.querySelectorAll<HTMLElement>(".canvas-trail-edge")].map(el => el.style.cssText),
      animations: trail.getAnimations({ subtree: true }),
      time: Number(trail.getAnimations({ subtree: true })[0].currentTime),
    };
  });
  const assertUnchanged = async () => {
    // Allow ResizeObserver notifications to flush, catching accidental board observers.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => {
      const trail = document.querySelector(".canvas-trail")!;
      const initial = (window as any).initialTrail;
      const current = trail.getAnimations({ subtree: true });
      return {
        sameRoute: JSON.stringify([...trail.querySelectorAll<HTMLElement>(".canvas-trail-edge")].map(el => el.style.cssText)) === JSON.stringify(initial.edges),
        sameAnimations: current.length === initial.animations.length && current.every((a, i) => a === initial.animations[i]),
        running: current.every(a => a.playState === "running"),
        advanced: Number(current[0].currentTime) > initial.time,
      };
    })).toEqual({ sameRoute: true, sameAnimations: true, running: true, advanced: true });
  };
  await page.getByRole("slider", { name: "Camera zoom" }).fill("0.25");
  await assertUnchanged();
  const grip = page.getByRole("button", { name: "Move Desktop artboard with arrow keys" });
  await grip.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await assertUnchanged();
  // Real pointer dragging must be just as independent as keyboard movement.
  const header = await page.locator('[data-preview-id="mobile"] .artboard-header').boundingBox();
  await page.mouse.move(header!.x + 20, header!.y + 15);
  await page.mouse.down();
  await page.mouse.move(header!.x - 180, header!.y + 95, { steps: 8 });
  await page.mouse.up();
  await assertUnchanged();
  await page.getByRole("button", { name: "Mobile actions", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Focus Mobile", exact: true }).click();
  await assertUnchanged();
  await page.getByRole("button", { name: "Unfocus Mobile", exact: true }).click();
  await assertUnchanged();
  await page.getByTestId("canvas").focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowRight");
  await assertUnchanged();
  // Even toggling the OS motion preference after a pan reuses the original route.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".canvas-trail-strip")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.locator(".canvas-trail-strip").count()).toBeGreaterThanOrEqual(4);
  expect(await page.evaluate(() => JSON.stringify([...document.querySelectorAll<HTMLElement>(".canvas-trail-edge")].map(el => el.style.cssText)) === JSON.stringify((window as any).initialTrail.edges))).toBe(true);
  await page.getByRole("button", { name: "Fit both", exact: true }).click();
  await expect(page.getByRole("button", { name: /Pause.*animation/i })).toHaveCount(0);
});

test("visibility, resize, reduced motion and unmount clean up correctly", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openWorkspace(page);
  await expect.poll(() => page.locator(".canvas-trail-strip").count()).toBeGreaterThanOrEqual(4);
  const motion = await page.locator(".canvas-trail").evaluate(el => el.getAnimations({ subtree: true }).map(a => ({
    state: a.playState,
    properties: Object.keys((a.effect as KeyframeEffect).getKeyframes()[0]).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key)),
  })));
  expect(motion.every(a => a.state === "running" && a.properties.join() === "transform")).toBe(true);
  // Simulate the browser visibility event without a flaky focus/background-tab dependency.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const pausedTimes = await page.locator(".canvas-trail").evaluate(async el => {
    const animations = el.getAnimations({ subtree: true });
    await Promise.all(animations.map(a => a.ready));
    return animations.map(a => a.currentTime);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator(".canvas-trail").evaluate(el => el.getAnimations({ subtree: true }).map(a => a.currentTime))).toEqual(pausedTimes);
  await page.setViewportSize({ width: 1000, height: 750 });
  await expect.poll(() => page.locator(".canvas-trail").evaluate(el => el.getAnimations({ subtree: true }).every(a => a.playState === "paused"))).toBe(true);
  await page.evaluate(() => { Reflect.deleteProperty(document, "hidden"); document.dispatchEvent(new Event("visibilitychange")); });
  expect(await page.locator(".canvas-trail").evaluate(el => el.getAnimations({ subtree: true }).every(a => a.playState === "running"))).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".canvas-trail-strip")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.locator(".canvas-trail-strip").count()).toBeGreaterThanOrEqual(4);
  await page.evaluate(() => {
    (window as any).trailAnimations = document.querySelector(".canvas-trail")!.getAnimations({ subtree: true });
    window.mauxi!.closeProject = async () => {
      const event = { active: null, recoveryConflicts: [] };
      (window as any).setupTest.workspaceListeners.forEach((listener: (event: unknown) => void) => listener(event));
      return event;
    };
  });
  await page.getByRole("button", { name: "Close project", exact: true }).click();
  await expect(page.locator(".canvas-background")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trailAnimations.every((a: Animation) => a.playState === "idle"))).toBe(true);
});

test("reduced-motion startup keeps the white static grid without creating animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWorkspace(page);
  await expect(page.locator(".canvas-background")).toBeVisible();
  await expect(page.locator(".canvas-trail-strip")).toHaveCount(0);
  await expect(page.locator(".canvas-motion-toggle")).toHaveCount(0);
});
