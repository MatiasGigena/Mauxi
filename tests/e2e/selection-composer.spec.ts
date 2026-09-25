import { expect, test, type Page } from "@playwright/test";
import { BRIDGE_PROTOCOL } from "../../src/application/preview-contract";
import { selectionCapture } from "../fixtures/selection";

async function attach(page: Page, key: string, interaction: "pointer" | "keyboard" = "pointer") {
  await page.evaluate(({ capture, protocol, interaction }) => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="desktop-preview"]')!;
    const session = new URL(frame.src).searchParams.get("mauxiSession")!;
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "http://127.0.0.1:45173", data: { protocol, session, generation: "generation-1", kind: "selection", interaction, capture } }));
  }, { capture: selectionCapture(key, `Selected ${key}`), protocol: BRIDGE_PROTOCOL, interaction });
}

async function finishMotion(page: Page) {
  await page.locator('.chat-dock').evaluate(async node => {
    await Promise.allSettled(node.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
  });
}

const active = (page: Page) => page.locator('.selection-list .selection-chip');

test.beforeEach(async ({ page }) => {
  // Exercise the real Workspace message boundary and composer, without a provider
  // or running fixture server. The synthetic preview only supplies handshake data.
  await page.route('http://127.0.0.1:45173/**', route => route.fulfill({ contentType: 'text/html', body: `<body>Preview<script>
    const session = new URL(location.href).searchParams.get('mauxiSession');
    addEventListener('message', event => { if (event.data.kind === 'connect') parent.postMessage({ protocol: ${JSON.stringify(BRIDGE_PROTOCOL)}, session, generation: 'generation-1', kind: 'ready', url: location.href, viewport: { width: innerWidth, height: innerHeight }, reactGrab: true }, '*'); });
  </script>` }));
  await page.goto('http://127.0.0.1:44173');
  await expect(page.locator('.bridge-ready')).toHaveCount(2);
});

test('minimal badges enter/exit, resize the surface without scaling text, and handle rapid changes', async ({ page }) => {
  const dock = page.locator('.chat-dock');
  const initialHeight = (await dock.boundingBox())!.height;
  await page.getByLabel('Message', { exact: true }).fill('Keep my draft.');
  await attach(page, 'one');
  await expect(active(page)).toHaveCount(1);
  await expect(active(page)).toHaveText('Selected one');
  await expect(active(page).getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Inspect|Revalidate/ })).toHaveCount(0);
  expect((await dock.boundingBox())!.height).toBeGreaterThan(initialHeight);
  const animatedProperties = await dock.evaluate(node => node.getAnimations({ subtree: true }).flatMap(animation => animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes().flatMap(frame => Object.keys(frame)) : []));
  expect(animatedProperties).not.toContain('height');
  expect(animatedProperties).not.toContain('width');
  await finishMotion(page);
  await attach(page, 'two');
  await active(page).filter({ hasText: 'Selected one' }).getByRole('button').click();
  await attach(page, 'one'); // Re-add an ID even while its exit is in flight.
  await finishMotion(page);
  await expect(active(page)).toHaveCount(2);
  await expect(page.locator('.selection-ghost')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft.');
  await active(page).first().getByRole('button').click();
  await active(page).first().getByRole('button').click();
  await finishMotion(page);
  await expect(active(page)).toHaveCount(0);
  await expect(page.locator('.selection-ghost')).toHaveCount(0);
  expect((await dock.boundingBox())!.height).toBeCloseTo(initialHeight, 0);
});

for (const remaining of [0, 1]) test(`deleted badge stays invisible at exit completion with ${remaining} remaining`, async ({ page }) => {
  if (remaining) await attach(page, 'keep');
  await attach(page, 'remove');
  await finishMotion(page);
  // Observe the exact finish event before React removes the ghost. Checking only
  // the eventual DOM misses a one-frame return to the default opacity of 1.
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (this.matches('.selection-ghost')) {
        const ghost = this;
        animation.addEventListener('finish', () => {
          document.documentElement.dataset.exitFinishOpacity = getComputedStyle(ghost).opacity;
          document.documentElement.dataset.exitFinishConnected = String(ghost.isConnected);
        });
      }
      return animation;
    };
  });
  await page.getByRole('button', { name: 'Remove selection Selected remove', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-exit-finish-opacity', '0');
  await expect(page.locator('html')).toHaveAttribute('data-exit-finish-connected', 'true');
  await expect(page.locator('.selection-ghost')).toHaveCount(0);
  await expect(active(page)).toHaveCount(remaining);
});

test('keyboard selection/removal is instant and focus returns to the editor', async ({ page }) => {
  await attach(page, 'keyboard', 'keyboard');
  const remove = active(page).getByRole('button');
  await expect(remove).toBeVisible();
  expect(await page.locator('.chat-surface').evaluate(node => node.getAnimations().length)).toBe(0);
  expect(await active(page).evaluate(node => node.getAnimations().length)).toBe(0);
  await remove.focus();
  await remove.press('Enter');
  await expect(page.locator('.selection-chip')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
});

test('reduced motion, wrapping, and live preference changes settle cleanly', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 850 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (let index = 0; index < 8; index++) await attach(page, `target-${index}`);
  await expect(active(page)).toHaveCount(8);
  expect(await active(page).first().evaluate(node => node.getAnimations().length)).toBe(0);
  const bounds = await page.locator('.chat-dock').boundingBox();
  for (const badge of await active(page).all()) {
    const box = await badge.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await active(page).first().getByRole('button').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.selection-ghost')).toHaveCount(0);
  expect(await page.locator('.chat-surface').evaluate(node => node.getAnimations().length)).toBe(0);
});
