import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { BrowserRequest, BrowserState, BrowserTarget, BrowserResult } from "../../src/application/browser-contract";

for (const fixture of ["vite", "next"]) test(`${fixture}: visible hover/type/scroll/logs, exact navigation and disconnect`, async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-operations-"));
  const config = path.resolve("fixtures/vite/vite.config.ts"), before = await readFile(config, "utf8");
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: fixture === "next" ? "" : "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let stderr = ""; app.process().stderr?.on("data", data => { stderr += String(data); });
  try {
    let page = await app.firstWindow();
    const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
    const plan = discovery.plans.find(p => p.appRoot.endsWith(`/fixtures/${fixture}`))!;
    const next = app.waitForEvent("window");
    await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const }); page = await next;
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 60_000 }).catch(async error => {
      await writeFile(testInfo.outputPath(`${fixture}-startup-debug.json`), JSON.stringify({ shell: await page.evaluate(() => ({ text: document.body.innerText, origin: location.origin })), frames: await Promise.all(page.frames().map(f => f.evaluate(() => ({ url: location.href, origin: location.origin, ready: document.readyState, name: window.name })).catch(() => null))), bootstrap: await page.evaluate(() => window.mauxi!.getBootstrap()), stderr }, null, 2));
      throw error;
    });
    const frame = page.frames().find(f => f.url().includes("mauxiPreview=desktop"))!;
    // A deterministic DOM fixture inserted in the EXISTING visible page, not another browser.
    await frame.evaluate(() => {
      const lab = document.createElement("section"); lab.id = "verification-lab";
      lab.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:white;padding:12px;display:flex;gap:10px";
      lab.innerHTML = '<style>#hover-probe {background:rgb(200,200,200)} #hover-probe:hover {background:rgb(1,2,3)}</style><button id="hover-probe" data-testid="hover-probe">Hover probe</button><input data-testid="typing-probe" aria-label="Typing probe" value="private-original"><input type="password" value="must-not-leak" data-testid="password-probe">';
      lab.querySelector("button")!.addEventListener("click", () => { lab.dataset.clicked = "yes"; });
      lab.querySelector("button")!.addEventListener("mouseover", () => { lab.dataset.hovered = "yes"; });
      lab.querySelector("input")!.addEventListener("input", () => { lab.dataset.typed = "yes"; }); document.body.prepend(lab);
    });
    const grant = async () => {
      await page.getByRole("button", { name: "Give agent control", exact: true }).click();
      await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible().catch(async error => {
        await writeFile(testInfo.outputPath(`${fixture}-target-debug.json`), JSON.stringify({ info: await page.evaluate(() => window.mauxi!.browserTest("targets")), tree: await app.evaluate(async ({ BrowserWindow }) => { const d=BrowserWindow.getAllWindows()[0].webContents.debugger; return { tree: await d.sendCommand("Page.getFrameTree"), targets: await d.sendCommand("Target.getTargets") }; }) }, null, 2)); throw error;
      });
      await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).owner)).toBe("agent");
      const info = await page.evaluate(() => window.mauxi!.browserTest("targets")) as { state: BrowserState; targets: BrowserTarget[] };
      expect(info.state.owner).toBe("agent");
      return { ...info.targets.find(t => t.previewId === "desktop")!, generation: info.state.generation };
    };
    const target = await grant();
    const run = (r: BrowserRequest) => page.evaluate(request => window.mauxi!.browserTest(request), r) as Promise<BrowserResult>;
    // Framework hydration may replace history without changing the document.
    await frame.evaluate(() => history.replaceState(history.state, "", location.href));
    await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).generation)).toBe(target.generation);
    const action = async (r: BrowserRequest, approve = true) => {
      const pending = run(r).then(value => ({ value, error: "" }), error => ({ value: undefined, error: String(error) }));
      await expect(page.getByRole("dialog", { name: "Approve browser action" })).toBeVisible();
      await page.getByRole("button", { name: approve ? "Approve once" : "Deny", exact: true }).click();
      return pending;
    };
    const inspect = await run({ ...target, operation: "inspect" });
    expect(inspect.text).not.toContain("private-original"); expect(inspect.text).not.toContain("must-not-leak");
    const nodes = JSON.parse(inspect.text).entries;
    const hover = nodes.find((n: any) => n.testId === "hover-probe").target;
    const input = nodes.find((n: any) => n.testId === "typing-probe").target;
    const hovered = await action({ ...target, operation: "hover", target: hover }); expect(hovered.error).toBe("");
    await expect(frame.locator("#verification-lab")).toHaveAttribute("data-hovered", "yes");
    await expect(frame.locator("#hover-probe")).toHaveCSS("background-color", "rgb(1, 2, 3)");
    const typed = await action({ ...target, operation: "type", target: input, text: "safe local test value" }); expect(typed.error).toBe("");
    await expect(frame.getByTestId("typing-probe")).toHaveValue("safe local test value");
    await expect(frame.locator("#verification-lab")).toHaveAttribute("data-typed", "yes");
    const scrolled = await action({ ...target, operation: "scroll", y: 180 }); expect(scrolled.error).toBe("");
    expect(await frame.evaluate(() => scrollY)).toBeGreaterThan(0);
    await frame.evaluate(() => { console.log("visible-proof-console"); setTimeout(() => { throw new Error("visible-proof-error"); }, 0); });
    await expect.poll(async () => (await run({ ...target, operation: "console" })).text).toContain("visible-proof-error");
    expect((await run({ ...target, operation: "console" })).text).toContain("visible-proof-console");
    const capture = await run({ ...target, operation: "screenshot" });
    await writeFile(testInfo.outputPath(`${fixture}-operations.png`), Buffer.from(capture.image!, "base64"));
    await page.getByRole("button", { name: "Take back control", exact: true }).click();
    await expect(frame.locator("#hover-probe")).toHaveCSS("background-color", "rgb(200, 200, 200)");
    // Labels AND geometry shown in an approval must still match at dispatch.
    for (const change of ["label", "bounds"]) {
      const changedTarget = await grant();
      const entries = JSON.parse((await run({ ...changedTarget, operation: "inspect" })).text).entries;
      const handle = entries.find((entry: any) => entry.testId === "hover-probe").target;
      const pending = run({ ...changedTarget, operation: "click", target: handle }).then(() => "unexpected execution", error => String(error));
      const approval = page.getByRole("dialog", { name: "Approve browser action" });
      await expect(approval).toContainText("Target: <button> Hover probe");
      await expect(approval).toContainText('"testId": "hover-probe"');
      await frame.evaluate(change => {
        const node = document.getElementById("hover-probe")!;
        if (change === "label") node.setAttribute("aria-label", "Delete fixture records");
        else node.style.transform = "translateX(15px)";
      }, change);
      await page.getByRole("button", { name: "Approve once", exact: true }).click();
      expect(await pending).toMatch(/Stale DOM target|changed after approval/);
      expect(await frame.locator("#verification-lab").getAttribute("data-clicked")).toBeNull();
      await frame.evaluate(() => { const node = document.getElementById("hover-probe")!; node.removeAttribute("aria-label"); node.style.transform = ""; });
    }
    // Denial is not approval and returns human input without killing the dev server.
    const deniedTarget = await grant(); const denied = await action({ ...deniedTarget, operation: "scroll", y: 100 }, false);
    expect(denied.error).toBeTruthy(); await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    // Exact same-origin navigation invalidates both the old document and its queued generation.
    const navTarget = await grant();
    const navigation = await action({ ...navTarget, operation: "navigate", route: "/?verification=next" });
    expect(navigation.error).toBe("");
    await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 30_000 });
    await expect(run({ ...navTarget, operation: "inspect" })).rejects.toThrow();
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    const externalTarget = await grant();
    const external = await action({ ...externalTarget, operation: "navigate", route: "https://example.com/" });
    expect(external.error).toContain("Unsupported");
    const callbackTarget = await grant();
    const callback = await action({ ...callbackTarget, operation: "navigate", route: "/callback?code=never-follow" });
    expect(callback.error).toContain("Unsupported");
    const disconnected = await grant();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.debugger.detach(); });
    await expect(page.getByTestId("desktop-preview")).not.toHaveAttribute("inert");
    await expect(run({ ...disconnected, operation: "scroll", y: 100 })).rejects.toThrow();
    await page.getByLabel("Message", { exact: true }).fill("Chat remains reachable after disconnect");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Chat remains reachable after disconnect");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({ path: testInfo.outputPath(`${fixture}-disconnect.png`) });
    const welcome = app.waitForEvent("window"); await page.getByRole("button", { name: "Close project", exact: true }).click(); page = await welcome;
    await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
  } finally { await writeFile(testInfo.outputPath(`${fixture}-operations-stderr.log`), stderr); await app.close(); await writeFile(config, before); await rm(state, { recursive: true, force: true }); }
});
