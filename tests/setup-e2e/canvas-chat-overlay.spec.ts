import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

for (const viewport of [{ width: 1280, height: 800 }, { width: 1280, height: 600 }, { width: 390, height: 800 }]) {
  test(`chat floats above the full canvas without resizing it at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route("http://127.0.0.1:5173/**", route => route.fulfill({ contentType: "text/html", body: '<body style="margin:0;min-height:100vh;background:linear-gradient(#fff,#b8dbd6)">Preview continues behind chat</body>' }));
    await mockDesktop(page);
    await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
    const canvas = page.getByTestId("canvas");
    const dock = page.getByRole("region", { name: "Chat", exact: true });
    await expect(dock).toBeVisible();
    await page.getByRole("slider", { name: "Camera zoom" }).fill("1");
    const bounds = (await canvas.boundingBox())!;
    const surface = (await page.locator(".canvas-surface").boundingBox())!;
    expect(bounds.y + bounds.height).toBeCloseTo(viewport.height, 0);
    expect(bounds.y + bounds.height).toBeCloseTo(surface.y + surface.height, 0);
    expect(bounds.y).toBeCloseTo(surface.y, 0);
    expect(bounds.height).toBeCloseTo(surface.height, 0);
    const board = page.getByRole("region", { name: "Desktop artboard", exact: true });
    const boardBounds = await board.boundingBox();
    const dockBounds = (await dock.boundingBox())!;
    const bottomGap = viewport.width <= 600 || viewport.height <= 650 ? 16 : 32;
    expect(viewport.height - dockBounds.y - dockBounds.height).toBeCloseTo(bottomGap, 0);
    const preview = (await page.getByTestId("desktop-preview").boundingBox())!;
    expect(preview.y + preview.height).toBeGreaterThan(dockBounds.y + dockBounds.height);
    expect(await dock.evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    expect(await canvas.evaluate(node => node.contains(document.elementFromPoint(5, innerHeight - 5)))).toBe(true);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this draft");
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      const emit = (event: unknown) => state.agentListeners.forEach((listener: (event: unknown) => void) => listener(event));
      emit({ type: "snapshot", snapshot: {
        ready: true, workspaceId: "test-workspace", providers: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `Provider ${i}`, authenticated: false, authMethods: [{ type: "api_key", label: `Sign in ${i}` }] })),
        models: [], messages: [], thinkingLevel: "off", runState: "idle", queued: { steering: 0, followUp: 0 }, status: "Ready",
      } });
      window.mauxi!.agentLogin = async () => { emit({ type: "dialog", dialog: { id: "overlay-login", kind: "secret", title: "Provider 0", message: "Enter API key" } }); };
      window.mauxi!.agentDialogResponse = async () => { emit({ type: "dialog-dismissed", id: "overlay-login" }); };
    });
    await page.getByRole("button", { name: "Models & providers", exact: true }).click();
    await expect(page.locator(".chat-settings")).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(bounds);
    expect(await board.boundingBox()).toEqual(boardBounds);
    await page.getByRole("button", { name: "Sign in 0", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Provider 0", exact: true })).toBeVisible();
    expect(await canvas.boundingBox()).toEqual(bounds);
    expect(await board.boundingBox()).toEqual(boardBounds);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    await page.getByRole("button", { name: "Close models and providers", exact: true }).click();
    await expect(page.locator(".chat-settings")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this draft");
    expect(await canvas.boundingBox()).toEqual(bounds);
    expect(await board.boundingBox()).toEqual(boardBounds);
    await page.screenshot({ path: testInfo.outputPath("canvas-behind-chat.png") });
  });
}
