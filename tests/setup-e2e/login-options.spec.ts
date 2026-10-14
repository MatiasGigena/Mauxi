import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

for (const mode of ["pointer", "keyboard", "reduced", "short"] as const) {
  test(`sign-in choices use text actions with a persistent selection: ${mode}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: mode === "pointer" || mode === "short" ? 1280 : 390, height: 800 });
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
    await mockDesktop(page);
    await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
    await page.evaluate(() => {
      const state = (window as any).setupTest;
      state.responses = [];
      window.mauxi!.agentDialogResponse = async response => {
        state.responses.push(response);
        await new Promise<void>(resolve => { state.finishResponse = resolve; });
      };

      state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "dialog", dialog: {
        id: "radius-choice", kind: "select", title: "Radius", message: "Sign in to Radius:", options: [
          { id: "browser", label: "Sign in with browser (recommended)" },
          { id: "device", label: "Sign in with device code (when signing in from another device)", description: "Complete sign-in on a different device." },
        ],
      } }));
    });
    const dialog = page.getByRole("dialog", { name: "Radius", exact: true });
    await expect(dialog).toBeVisible();

    if (mode === "short") await page.setViewportSize({ width: 1280, height: 280 });
    await expect(dialog.getByText("Sign in to Radius:", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: "Sign in to Radius:", exact: true })).toBeVisible();
    const first = dialog.getByRole("button", { name: "Sign in with browser (recommended)", exact: true });
    const second = dialog.getByRole("button", { name: /Sign in with device code/ });
    const proceed = dialog.getByRole("button", { name: "Continue", exact: true });
    await expect(proceed).toBeDisabled();

    for (const choice of [first, second]) {
      await expect(choice).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(choice).toHaveCSS("box-shadow", "none");
      await expect(choice).toHaveAttribute("aria-pressed", "false");
      await expect(choice.locator(".lucide-arrow-right")).toBeVisible();
      await expect(choice.locator("svg")).toHaveAttribute("aria-hidden", "true");
    }

    if (mode === "keyboard") { await first.focus(); await first.press("Space"); }
    else await first.click();
    await page.mouse.move(0, 0);
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(first).toHaveCSS("color", "rgb(20, 122, 122)");
    await expect(first.locator(".lucide-check")).toBeVisible();
    await expect(first.locator(".lucide-arrow-right")).toHaveCount(0);
    await expect.poll(() => first.locator("span").evaluate(node => getComputedStyle(node, "::after").transform)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    await expect(proceed).toBeEnabled();
    expect(await page.evaluate(() => (window as any).setupTest.responses)).toEqual([]);

    if (mode === "keyboard") { await first.press("Tab"); await expect(second).toBeFocused(); await second.press("Enter"); }
    else { await second.hover(); await expect(second).toHaveCSS("background-color", "rgba(0, 0, 0, 0)"); await second.click(); }

    await page.mouse.move(0, 0);
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(first.locator(".lucide-arrow-right")).toBeVisible();
    await expect(first.locator(".lucide-check")).toHaveCount(0);
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(second).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(second).toHaveCSS("box-shadow", "none");
    await expect(second).toHaveCSS("color", "rgb(185, 78, 56)");
    await expect(second.locator("span")).toHaveCSS("color", "rgb(185, 78, 56)");
    await expect(second.locator(".lucide-check")).toBeVisible();
    await expect(second.locator(".lucide-arrow-right")).toHaveCount(0);
    await expect(second.locator("small")).toHaveText("Complete sign-in on a different device.");

    if (mode === "keyboard" || mode === "reduced") await expect(second).toHaveCSS("transition-duration", "0s");
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);

    if (mode === "short") {
      for (const layer of [dialog, page.locator(".chat-content")]) {
        const { content, available } = await layer.evaluate(node => ({ content: node.scrollHeight, available: node.clientHeight }));
        expect(content).toBeLessThanOrEqual(available + 1);
      }

      const bounds = await proceed.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(280);
    }

    await page.screenshot({ path: testInfo.outputPath("sign-in-choices.png") });
    await proceed.click();
    await expect(first).toBeDisabled();
    await expect(second).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Continuing…", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).setupTest.responses)).toEqual([
      { workspaceId: "test-workspace", dialogId: "radius-choice", value: "device", cancelled: false },
    ]);
    await page.evaluate(() => (window as any).setupTest.finishResponse());
    await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    await expect(page.locator(".composer-toolbar")).toBeVisible();

    if (mode === "short") {
      await page.evaluate(() => {
        const state = (window as any).setupTest;
        state.agentListeners.forEach((listener: (event: unknown) => void) => listener({ type: "dialog", dialog: {
          id: "long-choice", kind: "select", title: "Choose an account", message: "Select an account to continue.",
          options: Array.from({ length: 20 }, (_, index) => ({ id: String(index), label: `Account ${index}` })),
        } }));
      });
      const longDialog = page.getByRole("dialog", { name: "Choose an account", exact: true });
      await expect(longDialog).toHaveCSS("overflow-y", "visible");
      expect(await page.locator(".chat-content").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await longDialog.getByRole("button", { name: "Account 19", exact: true }).click();
      await longDialog.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await page.evaluate(() => (window as any).setupTest.responses.at(-1).value)).toBe("19");
      await page.evaluate(() => (window as any).setupTest.finishResponse());
      await expect(page.locator(".agent-dialog-inline")).toHaveCount(0);
    }
  });
}
