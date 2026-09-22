import { expect, test } from "@playwright/test";

for (const [fixture, port] of [["vite", 45273], ["next", 45274]] as const) {
  test(`${fixture}: production hydrates and runs without a preview bridge`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    const bridgeRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/\.mauxi\/|bridge-entry|react-grab/.test(request.url())) bridgeRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${port}/?mauxiSession=inactive-production-probe&mauxiPreview=desktop`);
    await expect(page.getByTestId("known-target")).toBeVisible();
    await page.getByTestId("known-target").click();
    await expect(page.getByTestId("click-count")).toHaveText("Underlying clicks: 1");
    expect(await page.locator('[data-mauxi-source], [data-mauxi-overlay]').count()).toBe(0);
    expect(bridgeRequests).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${fixture}-production.png`) });
  });
}
