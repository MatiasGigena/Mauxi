import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserRequest, BrowserState, BrowserTarget, BrowserResult } from "../../src/application/browser-contract";

async function identities(page: Page) {
  await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).owner)).toBe("agent");
  return page.evaluate(() => window.mauxi!.browserTest("targets")) as Promise<{ state: BrowserState; targets: BrowserTarget[] }>;
}
async function run(page: Page, request: BrowserRequest) { return page.evaluate(r => window.mauxi!.browserTest(r), request) as Promise<BrowserResult>; }
async function startAction(page: Page, request: BrowserRequest) {
  // Leave the IPC pending while Playwright operates the REAL approval UI.
  await page.evaluate(r => { (window as any).actionResult = undefined; void window.mauxi!.browserTest(r).then(value => { (window as any).actionResult = { value }; }, error => { (window as any).actionResult = { error: String(error) }; }); }, request);
}
async function result(page: Page) { await expect.poll(() => page.evaluate(() => (window as any).actionResult)).toBeTruthy(); return page.evaluate(() => (window as any).actionResult); }

test("fake agent checks the visible state, approvals, stale targets, revocation, routing and forged messages", async () => {
  await mkdir("evidence/issue-8", { recursive: true });
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-browser-electron-"));
  const config = path.resolve("fixtures/vite/vite.config.ts"); const before = await readFile(config, "utf8");
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let stderr = ""; app.process().stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await writeFile("evidence/issue-8/electron-startup.json", JSON.stringify(await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, userData: app.getPath("userData") })), null, 2));
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find(candidate => candidate.appRoot.endsWith("/fixtures/vite"))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
    page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
    const desktop = page.frameLocator('[data-testid="desktop-preview"]');
    const mobile = page.frameLocator('[data-testid="mobile-preview"]');
    // State exists before the tool ever connects. A duplicate browser would read zero.
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
    const nodes = JSON.parse(inspection.text).entries as Array<{ target: string; testId: string }>;
    const button = nodes.find(n => n.testId === "known-target")!; expect(button).toBeTruthy();
    const source = await run(page, request("source", { target: button.target }));
    expect(JSON.parse(source.text)).toMatchObject({ status: "static-match", filePath: "src/components/ProofCard.tsx" });
    const shot = await run(page, request("screenshot")); expect(shot.image).toBeTruthy();
    await writeFile("evidence/issue-8/visible-desktop.png", Buffer.from(shot.image!, "base64"));
    await run(page, { ...info.targets.find(t => t.previewId === "mobile")!, generation: info.state.generation, operation: "inspect" });
    const mobileShot = await run(page, { ...info.targets.find(t => t.previewId === "mobile")!, generation: info.state.generation, operation: "screenshot" });
    await writeFile("evidence/issue-8/visible-mobile.png", Buffer.from(mobileShot.image!, "base64"));
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.id))).toEqual(contentsBefore);
    // Both keyboard focus and pointer input are excluded, not just a cosmetic overlay.
    expect(await page.getByTestId("desktop-preview").evaluate((f: HTMLIFrameElement) => f.inert && f.tabIndex === -1)).toBe(true);
    const box = await desktop.getByTestId("known-target").boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(desktop.getByTestId("click-count")).toHaveText("Underlying clicks: 1");
    await startAction(page, request("click", { target: button.target }));
    const approval = page.getByRole("dialog", { name: "Approve browser action" });
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("Target: <button> Increment proof counter");
    await expect(approval).toContainText('"testId": "known-target"');
    await expect(approval).toContainText('"bounds":');
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    expect((await result(page)).error).toBeUndefined();
    await expect(desktop.getByTestId("click-count")).toHaveText("Underlying clicks: 2");
    await expect(mobile.getByTestId("click-count")).toHaveText("Underlying clicks: 0");
    // Page text is not authority; cross-frame requests and eval are not capabilities.
    const child = page.frames().find(f => f.url().includes("mauxiPreview=desktop"))!;
    expect(await child.evaluate(() => typeof (window as any).mauxi)).toBe("undefined");
    await child.evaluate(() => parent.postMessage({ protocol: "mauxi-preview-v1", kind: "grant", owner: "agent", session: new URLSearchParams(location.search).get("mauxiSession"), generation: "forged" }, "*"));
    await expect(run(page, { ...request("inspect"), workspaceId: "foreign" })).rejects.toThrow(/stale/i);
    await expect(page.evaluate(r => window.mauxi!.browserTest({ ...r, operation: "evaluate", expression: "process.env" }), request("inspect"))).rejects.toThrow(/Unsupported/);
    // Replacing the node with an identical element must not retarget old handles.
    await startAction(page, request("click", { target: button.target }));
    await expect(approval).toContainText("Target: <button> Increment proof counter");
    await child.evaluate(() => { const old = document.querySelector('[data-testid="known-target"]')!; old.replaceWith(old.cloneNode(true)); });
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    expect((await result(page)).error).toContain("Stale DOM target");
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await expect(run(page, request("inspect"))).rejects.toThrow();
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    const nextInfo = await identities(page); const nextTarget = nextInfo.targets.find(t => t.previewId === "desktop")!;
    const nextRequest = { ...nextTarget, generation: nextInfo.state.generation, operation: "scroll" as const, y: 200 };
    await startAction(page, nextRequest);
    await expect(page.getByRole("dialog", { name: "Approve browser action" })).toBeVisible();
    await page.getByRole("button", { name: "Take back control", exact: true }).click();
    expect((await result(page)).error).toBeTruthy();
    await expect(page.getByRole("dialog", { name: "Approve browser action" })).toHaveCount(0);
    await expect(page.getByTestId("desktop-preview")).not.toHaveAttribute("inert");
    await page.getByText(/^Checks ·/).click();
    await expect(page.getByAltText("Actual desktop preview capture")).toBeVisible();
    await page.screenshot({ path: "evidence/issue-8/recorded-checks.png" });
    await page.getByText(/^Checks ·/).click();
    // A side-effectful submit changes the source route but never replays its POST/GET in the peer.
    let submissions = 0;
    await page.route("**/side-effect", async route => { if (route.request().method() === "POST") submissions++; await route.fulfill({ status: 200, body: "safe local counter" }); });
    await desktop.getByRole("button", { name: "Submit once", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    const submitInfo = await identities(page); const submitTarget = submitInfo.targets.find(t => t.previewId === "desktop")!;
    const submitRequest = { ...submitTarget, generation: submitInfo.state.generation, operation: "inspect" as const };
    const submitNodes = JSON.parse((await run(page, submitRequest)).text).entries;
    const submit = submitNodes.find((n: any) => n.tag === "button" && n.text === "Submit once"); expect(submit).toBeTruthy();
    await startAction(page, { ...submitRequest, operation: "click", target: submit.target });
    await page.getByRole("button", { name: "Approve once", exact: true }).click();
    await result(page); await expect.poll(() => submissions).toBe(1);
    await expect(mobile.getByTestId("submit-count")).toHaveText("Submissions: 0");
    expect(new URL(child.url()).pathname).toBe("/submitted");
    expect(new URL(page.frames().find(f => f.url().includes("mauxiPreview=mobile"))!.url()).pathname).toBe("/");
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    // Ordinary human route linking remains available after an explicit opt-in.
    await page.getByRole("button", { name: "Routes unlinked", exact: true }).click();
    await child.evaluate(() => history.pushState(null, "", "/ordinary-proof"));
    await expect.poll(() => page.frames().filter(f => { try { return new URL(f.url()).pathname === "/ordinary-proof"; } catch { return false; } }).length).toBe(2);
    await page.screenshot({ path: "evidence/issue-8/returned-control.png" });
    const welcome = app.waitForEvent("window"); await page.getByRole("button", { name: "Close project", exact: true }).click();
    page = await welcome; await expect(page.getByRole("button", { name: "Open project…" })).toBeVisible();
  } finally { await writeFile("evidence/issue-8/electron-stderr.log", stderr); await app.close(); await writeFile(config, before); await rm(state, { recursive: true, force: true }); }
});
