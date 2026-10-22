import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import type { AuditReport } from "../../src/application/audit-contract";
import { mockDesktop } from "./fixtures";
import { createServer } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ListeningAddress = Type.Object({ port: Type.Number() });

declare global { interface Window { auditRuns?: number } }

const report: AuditReport = {
  url: "http://127.0.0.1:5173/expected", route: "/expected", startedAt: "2026-10-19T00:00:00.000Z", durationMs: 1,
  widthsScanned: 1, profiles: [], snapshots: [], scrollers: [], resolved: [],
  summary: { bug: 1, review: 0, intentional: 0, serious: 0, moderate: 1, minor: 0 },
  findings: [{ id: "finding", kind: "target-size", title: "Small target", detail: "A small target", fixHint: "Enlarge it", criterion: null,
    severity: "moderate", classification: "bug", ranges: [[320, 320]], worst: { width: 320, height: 568 }, profiles: [], markers: [],
    element: { selector: "#target", tag: "button", label: "Target", testId: null, source: null, rect: { x: 10, y: 10, width: 20, height: 20 } },
  }],
};

for (const scenario of [
  { name: "refuses a redirected page", route: "/expected?mode=a#section", redirect: "/different?mode=a", path: "/different", outlined: false },
  { name: "refuses a different query on the requested path", route: "/expected?mode=a#section", redirect: "/expected?mode=b", path: "/expected", outlined: false },
  { name: "outlines the requested page", route: "/expected?mode=a#section", path: "/expected", outlined: true },
  { name: "outlines the current page with a different hash", route: "/#section", path: "/", outlined: true },
]) {
  test(`Show at ${scenario.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const bridge = await readFile("dist-electron/bridge-entry.js", "utf8");

    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const path = url.pathname;

      if (path === "/bridge.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(bridge);

        return;
      }

      if (path === "/expected" && url.search === "?mode=a" && scenario.redirect) {
        response.writeHead(302, { Location: scenario.redirect }); response.end();

        return;
      }

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><html><body><button id="target">Target</button><script type="module" src="/bridge.js"></script></body></html>');
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = Value.Parse(ListeningAddress, server.address());
    const origin = `http://127.0.0.1:${port}`;

    try {
      await mockDesktop(page);
      await page.evaluate(({ report, origin }) => {
        const confirm = window.mauxi!.confirmProject;
        window.mauxi!.confirmProject = async request => ({ ...await confirm(request), origin });
        window.mauxi!.bridgeReady = async () => {};

        window.auditRuns = 0;

        window.mauxi!.auditRun = async () => { window.auditRuns!++;

        return report; };
      }, { report: { ...report, route: scenario.route, url: origin + scenario.route }, origin });
      await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
      await expect(page.locator(".bridge-ready")).toHaveCount(2);
      // The canvas audits the page by itself when it opens, once.
      await page.getByRole("complementary", { name: "Responsive audit" }).getByRole("button", { name: /Small target/ }).first().click();
      expect(await page.evaluate(() => window.auditRuns)).toBe(1);
      await page.getByRole("button", { name: "Show at 320px", exact: true }).click();
      const mobile = page.frameLocator('[data-testid="mobile-preview"]');
      await expect.poll(() => mobile.locator("body").evaluate(() => location.pathname)).toBe(scenario.path);
      const outline = mobile.locator('[data-mauxi-overlay]', { hasText: "Small target" });
      const notice = page.locator(".workspace-notice");
      await expect.poll(async () => await outline.count() + await notice.count()).toBeGreaterThan(0);
      await writeFile(testInfo.outputPath("show-result.json"), JSON.stringify({ requested: scenario.route, actualPath: await mobile.locator("body").evaluate(() => location.pathname), outlined: await outline.count(), notice: await notice.allTextContents() }, null, 2));
      await page.screenshot({ path: testInfo.outputPath("show-result.png") });
      await expect(outline).toHaveCount(scenario.outlined ? 1 : 0);

      if (!scenario.outlined) await expect(notice).toContainText(`Mobile preview did not open ${scenario.route}; the finding was not outlined.`);
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  });
}
