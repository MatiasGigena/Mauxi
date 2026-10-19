import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { AUDIT_PROFILES } from "../../src/application/audit-contract";
import { AXE_IGNORED_INCOMPLETE, AXE_RULES } from "../../src/application/audit-axe";
import { buildReport, type AuditSample } from "../../src/application/audit-report";
import type { measurePage } from "../../src/infrastructure/audit/page-audit";
import type { AxeApi, runAxe } from "../../src/infrastructure/audit/axe-run";
import type { interactionStep } from "../../src/infrastructure/audit/page-interactions";

declare global {
  interface Window {
    auditMeasurement: { measurePage: typeof measurePage; runAxe: typeof runAxe; interactionStep: typeof interactionStep };
    axe: AxeApi;
  }
}

let browserSource: string;

test.beforeAll(async () => {
  const result = await build({ stdin: { contents: 'export { measurePage } from "./src/infrastructure/audit/page-audit"; export { runAxe } from "./src/infrastructure/audit/axe-run"; export { interactionStep } from "./src/infrastructure/audit/page-interactions";', resolveDir: process.cwd() }, bundle: true, platform: "browser", format: "iife", globalName: "auditMeasurement", write: false });
  browserSource = result.outputFiles[0].text;
});

async function samples(page: Page, html: string, axe = false): Promise<AuditSample[]> {
  await page.setContent(html);
  await page.addScriptTag({ content: browserSource });

  if (axe) await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const result: AuditSample[] = [];

  for (const profile of AUDIT_PROFILES.filter((item) => ["phone-sm", "desktop"].includes(item.id))) {
    await page.setViewportSize({ width: profile.width, height: profile.height });

    const measured = await page.evaluate(async ({ axe, options }) => {
      // The browser bundle runs the production functions with their normal page globals.
      const api = window.auditMeasurement;
      const run = axe ? await api.runAxe(window.axe, options) : null;
      const targets = [...new Set(run?.results.flatMap((rule) => rule.nodes.map((node) => node.target)) ?? [])];
      const measurement = api.measurePage({ full: true, maxElements: 6_000, targets });

      return { measurement, run, targets };
    }, { axe, options: { rules: AXE_RULES, maxNodes: 8, maxResults: 64, timeoutMs: 10_000, ignoredIncomplete: AXE_IGNORED_INCOMPLETE } });

    const sample: AuditSample = { width: profile.width, height: profile.height, profile, measurement: measured.measurement };

    if (measured.run) {
      sample.axe = measured.run.results.map((rule) => ({ ...rule, nodes: rule.nodes.map((node) => ({ ...node, element: measured.measurement.targets?.[measured.targets.indexOf(node.target)] ?? null })) }));
      sample.axeIgnored = measured.run.ignored;
      sample.axeOverLimit = measured.run.overLimit;
    }

    result.push(sample);
  }

  return result;
}

const reportOf = (values: AuditSample[]) => buildReport({ url: "http://127.0.0.1/measurement", route: "/measurement", startedAt: new Date().toISOString(), durationMs: 0, samples: values, snapshots: [] });

test("one clipped text container has one finding while keeping every measured width", async ({ page }, testInfo) => {
  const values = await samples(page, '<html lang="en"><head><title>Clipped text</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}p{overflow:hidden;white-space:nowrap;font:20px sans-serif;width:100%}</style></head><body><main><p data-testid="clip">This is a sentence with enough content to overflow the narrow screen but fit the desktop screen easily.</p></main></body></html>');
  // Sweep checks run without the full profile checks. Keep a width seen only by that sweep.
  await page.setViewportSize({ width: 400, height: 900 });

  const measurement = await page.evaluate(() => {
    return window.auditMeasurement.measurePage({ full: false, maxElements: 6_000 });
  });

  values.push({ width: 400, height: 900, profile: null, measurement });
  const report = reportOf(values);
  await writeFile(testInfo.outputPath("clipping.json"), JSON.stringify({ samples: values, report }, null, 2));
  await page.screenshot({ path: testInfo.outputPath("clipping.png") });
  const findings = report.findings.filter((finding) => finding.element?.testId === "clip");
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ kind: "content-clipped", classification: "bug", ranges: [[320, 400]] });
  expect(new Set(report.findings.map((finding) => finding.id)).size).toBe(report.findings.length);
});

test("ignored inconclusive axe nodes leave a profile unknown instead of passing", async ({ page }, testInfo) => {
  const values = await samples(page, '<html lang="en"><head><title>Contrast overlap</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:white}p{position:relative;font:20px sans-serif;color:#aaa}.overlap{display:none}@media(min-width:500px){.overlap{display:block;position:absolute;inset:0;background:white;z-index:1}}</style></head><body><main><p data-testid="contrast">Low contrast sentence.<span class="overlap">Covering text</span></p></main></body></html>', true);
  expect(values[1].axeIgnored).toContain("color-contrast");
  const report = reportOf(values);
  await writeFile(testInfo.outputPath("contrast.json"), JSON.stringify({ samples: values, report }, null, 2));
  await page.screenshot({ path: testInfo.outputPath("contrast.png") });
  const finding = report.findings.find((item) => item.rule?.id === "color-contrast" && item.element?.testId === "contrast");
  expect(finding).toBeDefined();
  expect(finding!.detail).toContain("unknown at Desktop (1440px)");
  expect(finding!.detail).not.toContain("not at");
  expect(finding!.title).not.toContain("only at");
});

test("keyboard focus inside a transparent ancestor is reported as invisible", async ({ page }, testInfo) => {
  await page.setContent('<html lang="en"><head><title>Hidden focus</title></head><body><main><div style="opacity:0"><button data-testid="transparent-focus">Hidden focus</button></div><button data-testid="visible-focus">Visible focus</button><svg data-testid="visible-svg-focus" tabindex="0" width="30" height="30" aria-label="Visible icon"><circle cx="15" cy="15" r="12" /></svg></main></body></html>');
  await page.addScriptTag({ content: browserSource });
  await page.evaluate(() => window.auditMeasurement.interactionStep({ action: "focus-start" }));
  await page.keyboard.press("Tab");

  const result = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute("data-testid"),
    measured: window.auditMeasurement.interactionStep({ action: "focus-measure" }),
  }));

  const visible = [];

  for (const testId of ["visible-focus", "visible-svg-focus"]) {
    await page.keyboard.press("Tab");

    const next = await page.evaluate(() => ({ active: document.activeElement?.getAttribute("data-testid"), measured: window.auditMeasurement.interactionStep({ action: "focus-measure" }) }));
    expect(next.active).toBe(testId);
    expect(next.measured.issues?.some((issue) => issue.variant === "offscreen")).toBe(false);
    visible.push(next);
  }

  await writeFile(testInfo.outputPath("transparent-focus.json"), JSON.stringify({ ...result, visible }, null, 2));
  await page.screenshot({ path: testInfo.outputPath("transparent-focus.png") });
  await page.evaluate(() => window.auditMeasurement.interactionStep({ action: "cleanup" }));
  expect(result.active).toBe("transparent-focus");
  expect(result.measured.issues).toContainEqual(expect.objectContaining({ kind: "focus-not-visible", variant: "offscreen", element: expect.objectContaining({ testId: "transparent-focus" }) }));
});
