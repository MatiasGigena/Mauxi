import { expect, test, type Locator } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AuditReport } from "../../src/application/audit-contract";
import { mockDesktop } from "./fixtures";

const report: AuditReport = {
  url: "http://127.0.0.1:5173/", route: "/", startedAt: "2026-11-13T00:00:00.000Z", durationMs: 1,
  widthsScanned: 78, profiles: [], snapshots: [], scrollers: [], resolved: [],
  summary: { bug: 1, review: 1, intentional: 0, serious: 1, moderate: 1, minor: 0 },
  findings: [
    { id: "overflow", kind: "target-size", title: "Horizontal scroll at 320–624px", detail: "Box is 600px wide.", fixHint: "Use a fluid width.", criterion: null,
      severity: "serious", classification: "bug", ranges: [[320, 624]], worst: { width: 320, height: 568 }, profiles: [], markers: [],
      element: { selector: "#table", tag: "div", label: "Table", testId: null, source: null, rect: { x: 10, y: 10, width: 600, height: 200 } } },
    { id: "target", kind: "target-size", title: "Small target", detail: "A small target", fixHint: "Enlarge it", criterion: null,
      severity: "moderate", classification: "review", ranges: [[320, 400]], worst: { width: 320, height: 568 }, profiles: [], markers: [],
      element: { selector: "#target", tag: "button", label: "Target", testId: null, source: null, rect: { x: 10, y: 10, width: 20, height: 20 } } },
  ],
};

const ListeningAddress = Type.Object({ port: Type.Number() });

const DARK_CANVAS = "rgb(17, 18, 22)";
const DARK_SURFACE = "rgb(25, 26, 31)";
const LIGHT = "rgb(255, 255, 255)";

test("dark mode is the default and the choice to switch persists on the launch screen and in the workspace", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const evidence: Array<{ step: string; theme: string | null; background: string; stored: string | null }> = [];

  const record = async (step: string, surface: Locator) => {
    const entry = { step, theme: await page.locator("html").getAttribute("data-theme"), background: await surface.evaluate(node => getComputedStyle(node).backgroundColor), stored: await page.evaluate(() => localStorage.getItem("mauxi-theme")) };

    evidence.push(entry);

    return entry;
  };

  const bridge = await readFile("dist-electron/bridge-entry.js", "utf8");

  const server = createServer((request, response) => {
    const script = request.url === "/bridge.js";

    response.writeHead(200, { "Content-Type": script ? "text/javascript" : "text/html" });
    response.end(script ? bridge : '<!doctype html><html><body style="font-family:sans-serif;padding:24px"><h1>Coffee that tastes like where it grew</h1><button id="target">Target</button><script type="module" src="/bridge.js"></script></body></html>');
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${Value.Parse(ListeningAddress, server.address()).port}`;

  try {

  await mockDesktop(page);
  const html = page.locator("html");
  const launch = page.locator(".launch-screen");
  const logo = page.locator(".launch-logo");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(launch).toHaveCSS("background-color", DARK_CANVAS);
  await expect(logo).toHaveAttribute("src", /logo-mauxi-text-light/);
  expect(await record("launch default", launch)).toEqual({ step: "launch default", theme: "dark", background: DARK_CANVAS, stored: null });
  await page.screenshot({ path: testInfo.outputPath("launch-dark.png") });

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(launch).toHaveCSS("background-color", LIGHT);
  await expect(logo).not.toHaveAttribute("src", /logo-mauxi-text-light/);
  await page.screenshot({ path: testInfo.outputPath("launch-light.png") });

  // The choice survives a reload; the workspace opens in it.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  await page.locator(".project-setup").waitFor();
  await page.evaluate(({ report, origin }) => {
    const confirm = window.mauxi!.confirmProject;
    window.mauxi!.confirmProject = async request => ({ ...await confirm(request), origin });
    window.mauxi!.bridgeReady = async () => {};

    window.mauxi!.auditRun = async () => ({ ...report, url: origin + "/" });
  }, { report, origin });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Responsive audit" });
  await expect(panel.getByRole("button", { name: /Horizontal scroll/ })).toBeVisible();
  await panel.getByRole("button", { name: /Horizontal scroll/ }).click();

  const island = page.locator(".topbar .zoom");
  await expect(island).toHaveCSS("background-color", DARK_SURFACE);
  await expect(page.locator(".canvas-background")).toHaveCSS("background-color", DARK_CANVAS);
  await expect(page.locator(".audit-panel")).toHaveCSS("color", "rgb(236, 236, 240)");
  await record("workspace dark", island);
  await page.screenshot({ path: testInfo.outputPath("workspace-dark.png") });

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("button", { name: "Light mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(island).toHaveCSS("background-color", LIGHT);
  await expect(page.locator(".canvas-background")).toHaveCSS("background-color", LIGHT);
  await expect(page.getByRole("button", { name: "Dark mode" })).toBeVisible();
  expect(await record("workspace light", island)).toEqual({ step: "workspace light", theme: "light", background: LIGHT, stored: "light" });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("workspace-light.png") });

  await writeFile(testInfo.outputPath("theme-evidence.json"), JSON.stringify(evidence, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
});
