import { expect, test } from "@playwright/test";
import { mockDesktop } from "./fixtures";

interface ComposerMessageTest {
  messageNode: Element | null;
  messageAnimations: Array<{ frames: Keyframe[]; duration: EffectTiming["duration"] }>;
}

declare global {
  interface Window { composerMessageTest?: ComposerMessageTest }
}

for (const mode of ["pointer", "keyboard", "reduced"] as const) {
  test(`message field hides and restores its draft: ${mode}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
    await mockDesktop(page);
    await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("An unfinished draft");
    await page.evaluate(() => {
      const state: ComposerMessageTest = { messageNode: document.querySelector("#chat-message"), messageAnimations: [] };
      window.composerMessageTest = state;
      const animate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function (frames, options) {
        const animation = animate.call(this, frames, options);

        if (this.classList.contains("composer-message")) state.messageAnimations.push({ frames: Array.isArray(frames) ? frames : [], duration: animation.effect?.getTiming().duration });

        return animation;
      };
    });
    const toggle = page.getByRole("button", { name: "Models & providers", exact: true });

    if (mode === "keyboard") {
      await toggle.focus();
      await toggle.press("Enter");
    } else await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#chat-message")).toBeHidden();
    await expect(message).toHaveCount(0);
    await expect(page.locator(".composer-message")).toHaveAttribute("inert", "");
    await expect(page.locator(".composer button[type=submit]")).toBeDisabled();

    const close = page.getByRole("button", { name: "Close models and providers" });

    if (mode === "keyboard") {
      await close.focus();
      await close.press("Enter");
    } else await close.click();
    await expect(message).toBeVisible();
    await expect(message).toHaveValue("An unfinished draft");
    await expect(toggle).toBeFocused();
    await expect(page.locator(".chat-settings")).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector("#chat-message") === window.composerMessageTest!.messageNode)).toBe(true);
    const animations = await page.evaluate(() => window.composerMessageTest!.messageAnimations);

    if (mode === "pointer") {
      expect(animations.map(animation => animation.duration)).toEqual([110, 160]);
      expect(animations[0].frames.at(-1)).toMatchObject({ opacity: 0, transform: "translateY(-12%) scale(.97)" });
      expect(animations[1].frames[0]).toMatchObject({ opacity: 0, transform: "translateY(15%) scale(.97)" });
    } else expect(animations).toEqual([]);

    await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>(".model-picker")!;

      for (let i = 0; i < 4; i++) {
        button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        button.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(message).toBeVisible();
    await expect(message).toHaveValue("An unfinished draft");
    await expect(page.locator(".composer-panel-ghost")).toHaveCount(0);
    await expect.poll(() => page.locator(".composer-message").evaluate(node => getComputedStyle(node).opacity)).toBe("1");
    await expect(page.locator(".composer-message")).not.toHaveAttribute("inert");
  });
}
