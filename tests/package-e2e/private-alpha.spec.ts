import { closeProject as closeWorkspace } from "../helpers/workspace-controls";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BrowserTarget } from "../../src/application/browser-contract";

const exec = promisify(execFile);
const artifact = path.resolve(process.env.MAUXI_APPIMAGE ?? "release/Mauxi-0.1.0-x86_64.AppImage");

async function projectProcesses(root: string): Promise<number[]> {
  const result: number[] = [];

  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;

    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);

      if (cwd === root || cwd.startsWith(`${root}/`)) result.push(Number(pid));
    } catch {}
  }

  return result;
}

async function alive(pids: number[]): Promise<number[]> {
  const running: number[] = [];

  for (const pid of pids) {
    try { if (!(await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].startsWith("Z ")) running.push(pid); }
    catch {}
  }

  return running;
}

async function openProject(app: ElectronApplication, page: Page, root: string) {
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, root);
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const next = app.waitForEvent("window");
  await page.getByRole("button", { name: /Confirm.*start/i }).click();
  page = await next;
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(async () => (await window.mauxi!.agentBootstrap()).ready)).toBe(true);

  return page;
}

async function closeProject(app: ElectronApplication, page: Page) {
  const next = app.waitForEvent("window");
  await closeWorkspace(page);
  page = await next;
  await expect(page.getByRole("button", { name: "Open Project", exact: true })).toBeVisible();

  return page;
}

async function expectProjectClean(project: string, framework: "vite" | "next", expectedConfig: string, pids: number[]) {
  await expect.poll(() => alive(pids), { timeout: 10_000 }).toEqual([]);
  await expect.poll(() => projectProcesses(project)).toEqual([]);
  expect(await readFile(path.join(project, framework === "next" ? "next.config.mjs" : "vite.config.ts"), "utf8")).toBe(expectedConfig);
  await expect(lstat(path.join(project, ".mauxi", "bridge.js"))).rejects.toMatchObject({ code: "ENOENT" });

  if (framework === "next") await expect(lstat(path.join(project, "instrumentation-client.js"))).rejects.toMatchObject({ code: "ENOENT" });
}

for (const fixture of ["vite", "next"] as const) test(`${fixture}: AppImage without pi, selected edit, visible checks, undo and isolated reopen cycles`, async ({}, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-package-"));
  const home = path.join(root, "home"); const bin = path.join(root, "bin");
  await mkdir(home); await mkdir(bin);
  await symlink(process.execPath, path.join(bin, "node"));
  const npm = (await exec("which", ["npm"])).stdout.trim();
  await symlink(npm, path.join(bin, "npm"));

  const env: Record<string, string> = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    PATH: `${bin}:/usr/bin:/bin`, APPIMAGE_EXTRACT_AND_RUN: "1", NEXT_TELEMETRY_DISABLED: "1", PI_TELEMETRY: "0",
    ...Object.fromEntries(["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
  };

  await expect(exec("/bin/sh", ["-c", "command -v pi"], { env })).rejects.toThrow();
  const projects = fixture === "vite" ? ["vite", "vite-isolated"] : ["next"];

  for (const name of projects) {
    const source = path.resolve("fixtures", name.startsWith("vite") ? "vite" : "next");
    const destination = path.join(root, name);
    await cp(source, destination, { recursive: true, filter: file => !["node_modules", "dist", ".next", ".mauxi"].includes(path.basename(file)) });
    await symlink(path.resolve("node_modules"), path.join(destination, "node_modules"));
  }

  const requests: any[] = [];
  let workspaceId = ""; let editingNext = false;
  let providerError = "";

  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body); requests.push(parsed);
        const messages = parsed.messages as Array<{ role: string; content: any }>;
        const lastUser = messages.findLastIndex(message => message.role === "user" && /Polish this selected fixture button|Verify both visible previews/.test(JSON.stringify(message.content)));
        const results = messages.slice(lastUser + 1).filter(message => message.role === "tool");
        const verify = JSON.stringify(messages[lastUser]).includes("Verify both visible previews");
        let tool: { name: string; arguments: string } | undefined;

        if (!verify && results.length === 0) tool = { name: "workspace_edit", arguments: JSON.stringify({
          path: `${editingNext ? "app" : "src"}/components/ProofCard.tsx`, oldText: "Run action", newText: "Polished action",
        }) };

        if (verify) {
          if (!results.length) tool = { name: "browser_targets", arguments: JSON.stringify({ workspaceId }) };
          else if (results.length <= 4) {
            const content = results[0].content;
            const text = typeof content === "string" ? content : content.find((part: any) => part.type === "text").text;
            const targets = JSON.parse(text) as { generation: number; targets: BrowserTarget[] };
            const index = results.length - 1;
            tool = { name: "browser_action", arguments: JSON.stringify({ ...targets.targets.find(target => target.previewId === (index < 2 ? "desktop" : "mobile")), generation: targets.generation, operation: index % 2 ? "screenshot" : "inspect" }) };
          }
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        const push = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: `fake-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "alpha", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        push({ role: "assistant", content: "" });

        if (tool) { push({ tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: "function", function: tool }] }); push({}, "tool_calls"); }
        else {
          const words = (verify ? "Local fixture: desktop and mobile observations returned. Real-model quality remains unverified." : "Local fixture edit completed. Browser verification is still pending.").split(" ");
          let index = 0;

          const timer = setInterval(() => {
            push({ content: `${words[index++]} ` });

            if (index === words.length) { clearInterval(timer); push({}, "stop"); response.end("data: [DONE]\n\n"); }
          }, 80);

          response.once("close", () => clearInterval(timer));

          return;
        }

        response.end("data: [DONE]\n\n");
      } catch (error) { providerError = String(error); response.writeHead(500); response.end("Local fixture error"); }
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

 if (!address || typeof address === "string") throw new Error("No local provider");
  const profile = path.join(env.XDG_CONFIG_HOME, "Mauxi", "pi-profile");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { "alpha-local": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-placeholder", api: "openai-completions",
    models: [{ id: "alpha", name: "Alpha local fake", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  let app: ElectronApplication | undefined;
  const report: Record<string, unknown> = { artifact, sha256: createHash("sha256").update(await readFile(artifact)).digest("hex"), provider: "loopback fake; $0; no live auth", cycles: [] };
  let stderr = ""; let completed = false;

  try {
    app = await electron.launch({ executablePath: artifact, args: [], env, chromiumSandbox: true, timeout: 60_000 });
    app.process().stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-120_000); });
    report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, versions: process.versions, arguments: process.argv, userData: app.getPath("userData"), path: process.env.PATH }));
    expect((report.runtime as any).packaged).toBe(true);
    expect((report.runtime as any).arguments).not.toContain("--no-sandbox");
    let page = await app.firstWindow();
    const cleanConfigs = new Map<string, string>();

    for (const name of projects) {
      const project = path.join(root, name); editingNext = name === "next";
      const config = path.join(project, editingNext ? "next.config.mjs" : "vite.config.ts");
      let expectedConfig = await readFile(config, "utf8");
      const relativeSource = `${editingNext ? "app" : "src"}/components/ProofCard.tsx`;
      const sourcePath = path.join(project, relativeSource);
      const original = await readFile(sourcePath, "utf8");

      for (let cycle = 0; cycle < 2; cycle++) {
        page = await openProject(app, page, project);
        workspaceId = (await page.evaluate(() => window.mauxi!.getBootstrap())).active!.workspaceId;
        const desktop = page.frameLocator('[data-testid="desktop-preview"]');
        const mobile = page.frameLocator('[data-testid="mobile-preview"]');
        const pids = await projectProcesses(project); expect(pids.length).toBeGreaterThan(0);
        const cookie = await desktop.locator("body").evaluate(() => document.cookie.split("; ").find(value => value.startsWith("alpha-isolation=")) ?? null);
        expect(cookie).toBe(cycle ? `alpha-isolation=${name}` : null);
        await desktop.locator("body").evaluate((_element, value) => { document.cookie = `alpha-isolation=${value}; Path=/; Max-Age=3600; SameSite=Lax`; }, name);
        await expect.poll(() => mobile.locator("body").evaluate(() => document.cookie)).toContain(`alpha-isolation=${name}`);
        const marker = await desktop.locator("body").evaluate(() => localStorage.getItem("alpha-workspace"));
        expect(marker).toBe(cycle ? name : null);
        await desktop.locator("body").evaluate((_element, value) => localStorage.setItem("alpha-workspace", value), name);
        await expect.poll(() => mobile.locator("body").evaluate(() => localStorage.getItem("alpha-workspace"))).toBe(name);

        if (cycle === 0 && name !== "vite-isolated") {
          await desktop.getByText("Use local test account", { exact: true }).click();
          const authLabel = editingNext ? "Authenticated on server" : "Authenticated locally";
          await expect(desktop.getByTestId("auth-state")).toHaveText(authLabel);
          await mobile.locator("body").evaluate(() => location.reload());
          await expect(mobile.getByTestId("auth-state")).toHaveText(authLabel);
          await expect(page.locator(".bridge-ready")).toHaveCount(2);

          if (editingNext) expect(await desktop.locator("body").evaluate(() => document.cookie)).not.toContain("mauxi-next-auth");
          report[`${name}CookieLogin`] = { sharedWithinWorkspace: true, httpOnly: editingNext };
          await page.getByRole("button", { name: /Models & providers|alpha-local ·/ }).click();
          const provider = page.locator(".provider-list article").filter({ hasText: "alpha-local" });
          await provider.getByRole("button", { name: "Re-authenticate" }).click();
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(page.locator(".chat-settings")).toBeVisible();
          await provider.getByRole("button", { name: "Re-authenticate" }).click();
          await page.locator('input[type="password"]').fill("fake-alpha-secret");
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await page.getByRole("combobox", { name: /^Model/ }).click();
          await page.getByRole("option").filter({ hasText: "alpha-local" }).first().click();

          for (const [side, color] of [["desktop", "rgb(230, 20, 30)"], ["mobile", "rgb(10, 80, 230)"]] as const) {
            const frame = page.frameLocator(`[data-testid="${side}-preview"]`);
            await expect.poll(() => frame.getByTestId("known-target").evaluate(node => Object.keys(node).some(key => key.startsWith("__reactProps$") && typeof (node as any)[key]?.onClick === "function"))).toBe(true);
            await frame.getByTestId("known-target").evaluate((node, background) => { node.style.background = background; node.scrollIntoView({ block: "center" }); }, color);
            const label = side === "desktop" ? "Desktop" : "Mobile";
            await page.getByRole("button", { name: `Select in ${label}`, exact: true }).click();
            await expect.poll(() => frame.locator("html").evaluate(node => getComputedStyle(node).cursor)).toBe("crosshair");
            const frameBox = await page.getByTestId(`${side}-preview`).boundingBox();

            const target = await frame.getByTestId("known-target").evaluate(node => {
              const r = node.getBoundingClientRect();

 return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth, height: innerHeight };
            });

            await page.mouse.click(frameBox!.x + target.x * frameBox!.width / target.width, frameBox!.y + target.y * frameBox!.height / target.height);
            await expect(page.locator(".selection-chip")).toHaveCount(side === "desktop" ? 1 : 2);
            await expect(frame.getByTestId("click-count")).toContainText("0");
            const chip = page.locator(`.selection-chip[data-selection-preview="${side}"]`);
            await expect(chip).toHaveCount(1);
            await expect(chip.getByRole("button", { name: /Remove selection/ })).toBeVisible();
            await page.getByRole("button", { name: `Select in ${label}`, exact: true }).click();
          }

          await expect(page.locator(".selection-chip")).toHaveCount(2);
          const firstRequest = requests.length;
          await page.evaluate(() => {
            const sample = { frames: [] as number[], longTasks: [] as number[], previous: performance.now(), running: true };
            const observer = new PerformanceObserver(list => sample.longTasks.push(...list.getEntries().map(entry => entry.duration)));
            observer.observe({ type: "longtask" });

            const tick = (now: number) => { sample.frames.push(now - sample.previous); sample.previous = now;

 if (sample.running) requestAnimationFrame(tick); };

            requestAnimationFrame(tick);
            (window as any).alphaTiming = { sample, observer };
          });
          await page.getByLabel("Message", { exact: true }).fill("Polish this selected fixture button");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
          await page.getByLabel("Message", { exact: true }).fill("Keyboard probe + - 0 f h");
          await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keyboard probe + - 0 f h");
          await page.getByRole("button", { name: "Move Desktop artboard with arrow keys", exact: true }).focus();
          await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
          await expect(desktop.getByText("Polished action", { exact: true })).toBeVisible({ timeout: 30_000 });
          await expect(mobile.getByText("Polished action", { exact: true })).toBeVisible();
          await expect(page.locator(".change-review")).toHaveCount(0);
          report[`${name}Responsiveness`] = await page.evaluate(() => {
            const { sample, observer } = (window as any).alphaTiming;
            sample.running = false; observer.disconnect();
            const frames = sample.frames.slice(1).sort((a: number, b: number) => a - b);

            return { frames: frames.length, p95FrameMs: frames[Math.floor(frames.length * 0.95)], maxFrameMs: frames.at(-1), longTaskMs: sample.longTasks };
          });
          expect(await readFile(sourcePath, "utf8")).toBe(original.replace("Run action", "Polished action"));
          expect(JSON.stringify(requests[firstRequest])).toContain("Selection 1 [mobile]");
          expect(JSON.stringify(requests[firstRequest])).toContain("Selection 2 [desktop]");
          expect(JSON.stringify(requests[firstRequest])).toContain(createHash("sha256").update(original).digest("hex"));
          const userMessage = requests[firstRequest].messages.findLast((message: any) => message.role === "user");
          const images = userMessage.content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url) as string[];
          expect(images).toHaveLength(2);

          const pixels = await app.evaluate(({ nativeImage }, urls) => urls.map(url => {
            const image = nativeImage.createFromDataURL(url); const bytes = image.toBitmap();
            let red = 0; let blue = 0;

            for (let i = 0; i < bytes.length; i += 4) {
              const [b, g, r] = bytes.subarray(i, i + 3);

              if (r > 180 && r > g + 80 && r > b + 80) red++;

              if (b > 180 && b > g + 80 && b > r + 80) blue++;
            }

            return { ...image.getSize(), red: red / (bytes.length / 4), blue: blue / (bytes.length / 4) };
          }), images);

          expect(pixels[0].blue).toBeGreaterThan(0.1); expect(pixels[0].red).toBeLessThan(0.01);
          expect(pixels[1].red).toBeGreaterThan(0.1); expect(pixels[1].blue).toBeLessThan(0.01);
          expect(pixels.every(image => image.width > 10 && image.height > 10)).toBe(true);
          report[`${name}DualCaptures`] = pixels;
          await page.getByRole("button", { name: "Give agent control", exact: true }).click();
          await page.getByLabel("Message", { exact: true }).fill("Verify both visible previews");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await expect.poll(() => page.evaluate(async () => (await window.mauxi!.browserState()).evidence.length)).toBe(4);
          await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
          expect(providerError).toBe("");
          const snapshot = await page.evaluate(() => window.mauxi!.agentBootstrap());
          expect(JSON.stringify(snapshot)).not.toContain("fake-alpha-secret");
          const checks = await page.evaluate(async () => (await window.mauxi!.browserState()).evidence);

          for (const id of ["desktop", "mobile"]) expect(checks.some(check => check.previewId === id && !!check.image)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`${name}-packaged-verification.png`) });
          await writeFile(sourcePath, original);
          await expect(desktop.getByText("Run action", { exact: true })).toBeVisible();
          await expect(mobile.getByText("Run action", { exact: true })).toBeVisible();
        }

        const userEdit = `\n// retained alpha user edit ${cycle}\n`;
        expectedConfig += userEdit;
        await writeFile(config, `${await readFile(config, "utf8")}${userEdit}`);
        page = await closeProject(app, page);
        await expectProjectClean(project, editingNext ? "next" : "vite", expectedConfig, pids);
        (report.cycles as unknown[]).push({ name, cycle, stoppedPids: pids });
      }

      cleanConfigs.set(name, expectedConfig);
    }

    report.untrustedIpc = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const attacker = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });

      try {
        await attacker.loadURL("about:blank");
        const channels = [...(ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers.keys()].filter(name => name.startsWith("mauxi:"));
        const results = await attacker.webContents.executeJavaScript(`Promise.all(${JSON.stringify(channels)}.map(async channel => { try { await require('electron').ipcRenderer.invoke(channel, {}); return { channel, rejected: false }; } catch (error) { return { channel, rejected: /Untrusted IPC sender/.test(String(error)) }; } }))`);

        return results;
      } finally { attacker.destroy(); }
    });
    expect((report.untrustedIpc as Array<{ rejected: boolean }>).length).toBeGreaterThan(20);
    expect((report.untrustedIpc as Array<{ rejected: boolean }>).every(result => result.rejected)).toBe(true);
    const auth = await readFile(path.join(profile, "auth.json"));
    await app.close(); app = undefined;
    app = await electron.launch({ executablePath: artifact, args: [], env, chromiumSandbox: true, timeout: 60_000 });
    const reopenedProject = path.join(root, fixture);
    page = await openProject(app, await app.firstWindow(), reopenedProject);
    const reopenedPids = await projectProcesses(reopenedProject); expect(reopenedPids.length).toBeGreaterThan(0);
    expect(await readFile(path.join(profile, "auth.json"))).toEqual(auth);
    expect(await page.frameLocator('[data-testid="desktop-preview"]').locator("body").evaluate(() => localStorage.getItem("alpha-workspace"))).toBe(fixture);
    expect(await page.frameLocator('[data-testid="desktop-preview"]').locator("body").evaluate(() => document.cookie)).toContain(`alpha-isolation=${fixture}`);
    expect(await page.frameLocator('[data-testid="desktop-preview"]').locator("body").evaluate(() => [typeof window.mauxi, typeof (window as any).require])).toEqual(["undefined", "undefined"]);
    page = await closeProject(app, page);
    await expectProjectClean(reopenedProject, fixture, cleanConfigs.get(fixture)!, reopenedPids);
    report.reopenCleanup = { name: fixture, stoppedPids: reopenedPids, ownedFilesAbsent: true, configPreserved: true };
    const journals = path.join(env.XDG_CONFIG_HOME, "Mauxi", "recovery");

    for (const file of await readdir(journals)) if (file.endsWith(".json")) expect(JSON.parse(await readFile(path.join(journals, file), "utf8")).state).toBe("clean");
    report.requests = requests.length;
    completed = true;
  } finally {
    if (!completed && app) {
      const page = app.windows().find(window => !window.isClosed());
      await page?.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => undefined);
      report.failureState = await page?.evaluate(() => window.mauxi!.getBootstrap()).catch(() => undefined);
    }

    await app?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(testInfo.outputPath("package-evidence.json"), JSON.stringify(report, null, 2));
    await writeFile(testInfo.outputPath("electron-stderr.log"), stderr);

    if (completed) await rm(root, { recursive: true, force: true });
    else await writeFile(testInfo.outputPath("recovery-location.txt"), root);
  }
});
