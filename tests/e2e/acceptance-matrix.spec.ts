import { selectFixture } from "../helpers/workspace-controls";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { latestSelection, observeSelections, resolvedSelection } from "../helpers/selection-evidence";

async function pick(page: Page, id: string, file: string, anchor: string, method: string) {
  const frame = page.frameLocator('[data-testid="desktop-preview"]');
  const target = id === "button-text" ? frame.getByTestId("known-target").locator("span") : frame.getByTestId(id);
  await target.evaluate(node => node.scrollIntoView({ block: "center" }));
  const bounds = await target.boundingBox();
  const canvas = await page.getByTestId("canvas").boundingBox();

  if (!bounds || !canvas) throw new Error("Missing target geometry");
  await page.getByTestId("canvas").dispatchEvent("wheel", {
    deltaX: bounds.x + bounds.width / 2 - (canvas.x + canvas.width / 2),
    deltaY: bounds.y + bounds.height / 2 - (canvas.y + canvas.height / 2),
  });
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-navigation-gesture", "false");

  if (id === "known-target") {
    const box = await target.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.05, box!.y + box!.height / 2);
  } else await target.click({ force: true });
  const chip = page.locator(".selection-chip");
  await expect(chip).toHaveCount(1);
  const evidence = await resolvedSelection(page);
  expect(evidence.capture.source.method).toBe(method);
  expect(evidence.source).not.toBeNull();
  const source = await readFile(file, "utf8");
  const offset = source.indexOf(anchor); expect(offset).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(anchor, offset + 1)).toBe(-1);
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  expect(evidence.source).toMatchObject({ filePath: file.replace(/^fixtures\/(vite|next)\//, ""), lineNumber: line, columnNumber: column, fileFingerprint: createHash("sha256").update(source).digest("hex") });
  await chip.getByRole("button", { name: /Remove selection/ }).click();
}

for (const scale of [1, 2]) for (const fixture of ["vite", "next"] as const) {
  test(`${fixture}: exact provenance, moving selection and reduced motion at display scale ${scale}`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const app = await electron.launch({ args: [path.resolve("dist-electron/main.js"), `--force-device-scale-factor=${scale}`], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_EVIDENCE_DIR: testInfo.outputPath("captures"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173" } });

    try {
      const page = await app.firstWindow();

      if (fixture === "next") await selectFixture(page, "next");
      await expect(page.locator(".bridge-ready")).toHaveCount(2);
      await observeSelections(page);
      await page.waitForTimeout(250);
      const desktop = page.frameLocator('[data-testid="desktop-preview"]');
      expect(await desktop.locator("body").evaluate(() => devicePixelRatio)).toBe(scale);
      const base = `fixtures/${fixture}/${fixture === "vite" ? "src" : "app"}`;
      const method = fixture === "vite" ? "react-grab" : "jsx-attribute";
      const samples: Record<string, number[]> = {};

      for (const id of ["motion-target", "gsap-target"]) {
        samples[id] = await desktop.getByTestId(id).evaluate(async node => {
          const positions: number[] = [];

          for (let i = 0; i < 15; i++) { positions.push(node.getBoundingClientRect().x); await new Promise(resolve => setTimeout(resolve, 40)); }

          return positions;
        });
        expect(Math.max(...samples[id]) - Math.min(...samples[id])).toBeGreaterThan(5);
      }

      await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();

      for (const zoom of ["0.25", "0.5", "1", "2"]) {
        await page.getByLabel("Camera zoom").fill(zoom);

        for (const id of ["motion-target", "gsap-target"]) await pick(page, id, `${base}/components/MotionProof.tsx`, id === "motion-target" ? '<button data-testid="motion-target"' : '<button ref={target}', method);
        await expect(desktop.getByTestId("motion-clicks")).toHaveText("Animation clicks: 0");
        await pick(page, "known-icon", `${base}/components/ProofCard.tsx`, '<path d=', method);
        await expect(desktop.getByTestId("click-count")).toContainText("0");
        await pick(page, "known-target", `${base}/components/ProofCard.tsx`, '<button className="primary"', method);
        await pick(page, "button-text", `${base}/components/ProofCard.tsx`, '<span>Run action', method);

        if (fixture === "vite") {
          for (const [id, anchor] of [["portal-target", '<aside className="portal-note"'], ["overlap-front", '<button data-testid="overlap-front"'], ["scrolled-target", '<button data-testid="scrolled-target"']] as const) await pick(page, id, `${base}/App.tsx`, anchor, method);
        } else {
          await pick(page, "next-scrolled-target", `${base}/page.tsx`, '<button data-testid="next-scrolled-target"', method);
          await pick(page, "server-heading", `${base}/page.tsx`, '<h1 data-testid="server-heading"', method);
        }
      }

      if (fixture === "vite") {
        await page.getByLabel("Camera zoom").fill("0.5");
        await desktop.getByTestId("identity-alpha").click();
        expect((await resolvedSelection(page)).source).toBeNull();
        await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();
        await desktop.getByTestId("unsupported-canvas").click();
        expect((await latestSelection(page)).support.status).toBe("unsupported");
        await page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ }).click();
      }

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(() => desktop.locator("body").evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

      for (const id of ["motion-target", "gsap-target"]) {
        await expect.poll(() => desktop.getByTestId(id).evaluate(node => {
          const transform = getComputedStyle(node.dataset.testid === "motion-target" ? node.parentElement! : node).transform;

          return transform === "none" ? 0 : new DOMMatrix(transform).m41;
        })).toBe(0);

        const positions = await desktop.getByTestId(id).evaluate(async node => {
          const before = node.getBoundingClientRect().x;
          await new Promise(resolve => setTimeout(resolve, 250));

          return [before, node.getBoundingClientRect().x];
        });

        expect(positions[1]).toBe(positions[0]);
      }

      await testInfo.attach("motion-observations", { body: JSON.stringify({ fixture, scale, samples }), contentType: "application/json" });
    } finally { await app.close(); }
  });
}

test("Next: delayed server bytes, visible fallback, hydrated card and client route preservation", async ({}, testInfo) => {
  const response = await fetch("http://127.0.0.1:45000/streaming");
  const reader = response.body!.getReader();
  let html = ""; let fallbackAt = 0; let contentAt = 0;

  for (;;) {
    const { done, value } = await reader.read();

 if (done) break;
    html += new TextDecoder().decode(value);

    if (!fallbackAt && html.includes('data-testid="streaming-fallback"')) fallbackAt = Date.now();

    if (!contentAt && html.includes('data-testid="streamed-content"')) contentAt = Date.now();
  }

  expect(fallbackAt).toBeGreaterThan(0);
  expect(contentAt - fallbackAt).toBeGreaterThan(700);
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_PROOF: "1", XDG_CONFIG_HOME: testInfo.outputPath("profile"), MAUXI_EVIDENCE_DIR: testInfo.outputPath("captures"), MAUXI_RENDERER_URL: "http://127.0.0.1:44173" } });

  try {
    const page = await app.firstWindow();
    await selectFixture(page, "next");
    await expect(page.locator(".bridge-ready")).toHaveCount(2);
    const desktop = page.frameLocator('[data-testid="desktop-preview"]');
    const mobile = page.frameLocator('[data-testid="mobile-preview"]');
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await desktop.locator("body").evaluate(() => { document.body.dataset.instance = "stream-route-instance"; });
    await desktop.getByRole("link", { name: "Delayed streaming route", exact: true }).click();
    await expect(desktop.getByTestId("streaming-fallback")).toBeVisible();
    await expect(desktop.getByTestId("streamed-content")).toBeVisible();
    await expect(desktop.getByTestId("streaming-fallback")).toHaveCount(0);
    await expect(mobile.getByTestId("streamed-content")).toBeVisible();
    await expect(page.locator(".bridge-ready")).toHaveCount(2);
    await desktop.getByTestId("known-target").click();
    await expect(desktop.getByTestId("click-count")).toContainText("1");
    await expect(mobile.getByTestId("click-count")).toContainText("0");
    expect(await desktop.locator("body").getAttribute("data-instance")).toBe("stream-route-instance");
    await desktop.getByRole("link", { name: "Return to fixture", exact: true }).click();
    await expect(mobile.getByRole("link", { name: "Delayed streaming route", exact: true })).toBeVisible();
    expect(await desktop.locator("body").getAttribute("data-instance")).toBe("stream-route-instance");
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
