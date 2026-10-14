import { browserIdentities, closeProject, runBrowser, toggleRoutes } from "../helpers/workspace-controls";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { BrowserRequest } from "../../src/application/browser-contract";

const InspectionSchema = Type.Object({ entries: Type.Array(Type.Object({ target: Type.String(), testId: Type.String() })) });

async function identities(page: Page) {
  await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).owner)).toBe("agent");

  return browserIdentities(page);
}

async function run(page: Page, request: BrowserRequest) { return runBrowser(page, request); }

function startAction(page: Page, request: BrowserRequest) {
  return page.evaluate(r => window.mauxi!.browserTest(r).then(() => ({ error: undefined }), error => ({ error: String(error) })), request);
}

test("fake agent checks the visible state, approvals, stale targets, revocation, routing and forged messages", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-browser-electron-"));
  const config = path.resolve("fixtures/vite/vite.config.ts"); const before = await readFile(config, "utf8");
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let stderr = ""; app.process().stderr?.on("data", chunk => { stderr += String(chunk); });

  try {
    await writeFile(testInfo.outputPath("electron-startup.json"), JSON.stringify(await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, userData: app.getPath("userData") })), null, 2));
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find(candidate => candidate.appRoot.endsWith("/fixtures/vite"))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
    const desktop = page.frameLocator('[data-testid="desktop-preview"]');
    const mobile = page.frameLocator('[data-testid="mobile-preview"]');
    await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
    await desktop.getByTestId("known-target").click();
    await expect(desktop.getByTestId("click-count")).toHaveText("Underlying clicks: 1");
    await expect(mobile.getByTestId("click-count")).toHaveText("Underlying clicks: 0");
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible();
    const info = await identities(page);
    expect(info.targets).toHaveLength(2); expect(info.state.owner).toBe("agent");
    const contentsBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.id));
    const target = info.targets.find(t => t.previewId === "desktop")!;
    const request = (operation: BrowserRequest["operation"], extra = {}): BrowserRequest => ({ ...target, generation: info.state.generation, operation, ...extra });
    const inspection = await run(page, request("inspect"));
    expect(inspection.text).toContain("Underlying clicks: 1");
    const nodes = Value.Parse(InspectionSchema, JSON.parse(inspection.text)).entries;
    const button = nodes.find(n => n.testId === "known-target")!; expect(button).toBeTruthy();
    const source = await run(page, request("source", { target: button.target }));
    expect(JSON.parse(source.text)).toMatchObject({ status: "static-match", filePath: "src/components/ProofCard.tsx" });
    const shot = await run(page, request("screenshot")); expect(shot.image).toBeTruthy();
    await writeFile(testInfo.outputPath("visible-desktop.png"), Buffer.from(shot.image!, "base64"));
    await run(page, { ...info.targets.find(t => t.previewId === "mobile")!, generation: info.state.generation, operation: "inspect" });
    const mobileShot = await run(page, { ...info.targets.find(t => t.previewId === "mobile")!, generation: info.state.generation, operation: "screenshot" });
    await writeFile(testInfo.outputPath("visible-mobile.png"), Buffer.from(mobileShot.image!, "base64"));
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.id))).toEqual(contentsBefore);
    expect(await page.getByTestId("desktop-preview").evaluate((f: HTMLIFrameElement) => f.inert && f.tabIndex === -1)).toBe(true);
    const box = await desktop.getByTestId("known-target").boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(desktop.getByTestId("click-count")).toHaveText("Underlying clicks: 1");
    const approved = startAction(page, request("click", { target: button.target }));
    const approval = page.getByRole("dialog", { name: "Approve browser action" });
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("Target: <button> Increment proof counter");
    await expect(approval).toContainText('"testId": "known-target"');
    await expect(approval).toContainText('"bounds":');
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    expect((await approved).error).toBeUndefined();
    await expect(desktop.getByTestId("click-count")).toHaveText("Underlying clicks: 2");
    await expect(mobile.getByTestId("click-count")).toHaveText("Underlying clicks: 0");
    const child = page.frames().find(f => f.url().includes("mauxiPreview=desktop"))!;
    expect(await child.evaluate(() => typeof window.mauxi === "undefined")).toBe(true);
    await child.evaluate(() => parent.postMessage({ protocol: "mauxi-preview-v1", kind: "grant", owner: "agent", session: new URLSearchParams(location.search).get("mauxiSession"), generation: "forged" }, "*"));
    await expect(run(page, { ...request("inspect"), workspaceId: "foreign" })).rejects.toThrow(/stale/i);
    await expect(page.evaluate(r => window.mauxi!.browserTest({ ...r, operation: "evaluate", expression: "process.env" }), request("inspect"))).rejects.toThrow(/Unsupported/);
    const stale = startAction(page, request("click", { target: button.target }));
    await expect(approval).toContainText("Target: <button> Increment proof counter");
    await child.evaluate(() => { const old = document.querySelector('[data-testid="known-target"]')!; old.replaceWith(old.cloneNode(true)); });
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    expect((await stale).error).toContain("Stale DOM target");
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await expect(run(page, request("inspect"))).rejects.toThrow();
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    const nextInfo = await identities(page); const nextTarget = nextInfo.targets.find(t => t.previewId === "desktop")!;
    const nextRequest = { ...nextTarget, generation: nextInfo.state.generation, operation: "scroll" as const, y: 200 };
    const revoked = startAction(page, nextRequest);
    await expect(page.getByRole("dialog", { name: "Approve browser action" })).toBeVisible();
    await page.getByRole("button", { name: "Take back control", exact: true }).click();
    expect((await revoked).error).toBeTruthy();
    await expect(page.getByRole("dialog", { name: "Approve browser action" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Interact with Desktop preview", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Interact with Desktop preview", exact: true }).click();
    await expect(page.getByTestId("desktop-preview")).not.toHaveAttribute("inert");
    const recorded = await page.evaluate(async () => (await window.mauxi!.browserState()).evidence);
    expect(recorded.some(check => check.previewId === "desktop" && !!check.image)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("returned-preview-control.png") });
    let submissions = 0;
    await page.route("**/side-effect", async route => { if (route.request().method() === "POST") submissions++; await route.fulfill({ status: 200, body: "safe local counter" }); });
    await desktop.getByRole("button", { name: "Submit once", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    const submitInfo = await identities(page); const submitTarget = submitInfo.targets.find(t => t.previewId === "desktop")!;
    const submitRequest = { ...submitTarget, generation: submitInfo.state.generation, operation: "inspect" as const };
    const submitNodes = JSON.parse((await run(page, submitRequest)).text).entries;
    const submit = submitNodes.find((n: any) => n.tag === "button" && n.text === "Submit once"); expect(submit).toBeTruthy();
    const submitted = startAction(page, { ...submitRequest, operation: "click", target: submit.target });
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    await submitted; await expect.poll(() => submissions).toBe(1);
    await expect(mobile.getByTestId("submit-count")).toHaveText("Submissions: 0");
    expect(new URL(child.url()).pathname).toBe("/submitted");
    expect(new URL(page.frames().find(f => f.url().includes("mauxiPreview=mobile"))!.url()).pathname).toBe("/");
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await toggleRoutes(page, false);
    await child.evaluate(() => history.pushState(null, "", "/ordinary-proof"));
    await expect.poll(() => page.frames().filter(f => { try { return new URL(f.url()).pathname === "/ordinary-proof"; } catch { return false; } }).length).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("returned-control.png") });
    const welcome = app.waitForEvent("window"); await closeProject(page);
    page = await welcome; await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
  } finally { await writeFile(testInfo.outputPath("electron-stderr.log"), stderr); await app.close(); await writeFile(config, before); await rm(state, { recursive: true, force: true }); }
});
