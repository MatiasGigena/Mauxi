// Walks onboarding and chat in Electron and fails on any renderer warning/error, page error, failed load,
// alert-style UI message or main-process stderr line. Each test writes console-messages.json (empty on success).
// Live run: MAUXI_LIVE_AUTH=<pi auth.json with openai-codex> npx playwright test --config playwright.setup.config.ts console-clean
import { closeProject } from "../helpers/workspace-controls";
import { chunk, text, toolCall } from "../helpers/fake-provider";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

interface Message { source: string; type: string; text: string; location?: string; page?: string; at?: number }

interface Log { messages: Message[]; notices: Message[]; phases: Array<{ name: string; at: number }>; watched: Set<Page>; started: number; shell?: string }

function record(log: Log, list: Message[], entry: Message) { list.push({ ...entry, at: Date.now() - log.started }); }

// Playwright attaches the Node inspector to Electron's main process; these lines come from the harness, not Mauxi.
const harness = /^(Debugger (listening|attached|ending) on |For help, see: https:\/\/nodejs\.org\/)/;

// Workspace notices also carry informational status (agent control, attached targets); only failure wording counts there.
const failure = /disconnect|fail|error|not saved|unavailable|could not|blocked/i;

// The hidden audit window loads the audited project itself; Electron's dev-binary check flags that page's own eval-friendly CSP (webpack/Next dev bundles).
const projectCsp = /Electron Security Warning \(Insecure Content-Security-Policy\)/;

const liveAuth = process.env.MAUXI_LIVE_AUTH;
const model = liveAuth ? { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" } : { provider: "console-local", id: "console", name: "Console local fake" };
const STOP_PROMPT = "Count slowly from 1 to 300, one number per line, with no other text.";
const TOOL_PROMPT = "Use workspace_read on package.json and reply with only its name field.";
const COMMAND_PROMPT = "Use workspace_command to run node with the single argument --version, then reply with only its output.";
const DENY_PROMPT = "Use workspace_command to run node with the single argument --version. If it is not executed, reply with only: skipped.";
const ChatRequestSchema = Type.Object({ messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })) });
const AddressSchema = Type.Object({ port: Type.Number() });

type Shot = (page: Page, name: string) => Promise<void>;

function watch(page: Page, log: Log) {
  if (log.watched.has(page)) return;
  log.watched.add(page);
  log.shell ??= new URL(page.url()).origin;
  page.on("console", message => {
    const value = message.text();
    const project = new URL(page.url()).origin !== log.shell;

    if (message.type() === "debug" && /^\[mauxi-(alert|notice)\] /.test(value)) {
      const kind = value.slice(7, value.indexOf("]"));
      record(log, kind === "alert" || failure.test(value) ? log.messages : log.notices, { source: "ui", type: kind, text: value.slice(value.indexOf("]") + 2), location: page.url() });
    }
    else if (["warning", "error", "assert"].includes(message.type())) record(log, project && projectCsp.test(value) ? log.notices : log.messages, { source: "renderer", type: message.type(), text: value, location: `${message.location().url}:${message.location().lineNumber}`, page: page.url() });
  });
  page.on("pageerror", error => record(log, log.messages, { source: "renderer", type: "pageerror", text: error.stack ?? error.message }));
  // Aborted loads are deliberate teardown (closing detaches the previews); Chromium does not report them.
  page.on("requestfailed", request => { if (request.failure()?.errorText !== "net::ERR_ABORTED") record(log, log.messages, { source: "network", type: "requestfailed", text: `${request.failure()?.errorText} ${request.url()}` }); });
  page.on("domcontentloaded", () => void page.evaluate(() => {
    const seen = new WeakMap<Element, string>();

    const scan = () => document.querySelectorAll('[role="alert"], .diagnostic.warning, .diagnostic.error, .send-error, .workspace-notice').forEach(node => {
      const value = node.textContent?.trim() ?? "";

      if (!value || seen.get(node) === value) return;
      seen.set(node, value); console.debug(`[mauxi-${node.matches(".workspace-notice") ? "notice" : "alert"}] ${value}`);
    });

    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true }); scan();
  }).catch(() => {}));
}

const agent = (page: Page) => page.evaluate(() => window.mauxi!.agentBootstrap());

async function send(page: Page, prompt: string, submit: "click" | "enter" = "click") {
  const before = (await agent(page)).messages.length;
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill(prompt);

  if (submit === "enter") await editor.press("Enter");
  else await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "User prompt" })).toContainText(prompt);
  await expect.poll(async () => (await agent(page)).messages.length, { timeout: 60_000 }).toBeGreaterThan(before);
}

async function settle(page: Page) {
  await expect.poll(async () => {
    const state = await agent(page);

    return state.runState === "idle" && !state.messages.some(item => item.pending);
  }, { timeout: 180_000 }).toBe(true);
  await expect(page.getByRole("log", { name: "Agent response" })).not.toBeEmpty();
}

async function selectTarget(page: Page) {
  const frame = page.frameLocator('[data-testid="desktop-preview"]');
  const target = frame.getByTestId("known-target");
  await expect(target).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();
  await expect.poll(() => frame.locator("html").evaluate(node => getComputedStyle(node).cursor)).toBe("crosshair");
  const box = (await page.getByTestId("desktop-preview").boundingBox())!;

  const point = await target.evaluate(node => {
    const r = node.getBoundingClientRect();

    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth, height: innerHeight };
  });

  await page.mouse.click(box.x + point.x * box.width / point.width, box.y + point.y * box.height / point.height);
  await expect(page.locator(".selection-chip")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("button", { name: "Select in Desktop", exact: true }).click();
}

type Renderer = "dev" | "packaged";

async function onboard(app: ElectronApplication, shot: Shot) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.resolve("."));
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  await expect(page.locator(".project-setup")).toBeVisible();
  await page.getByRole("button", { name: "Not this project? Choose another", exact: true }).click();
  await expect(page.locator(".project-setup")).toBeVisible();
  await page.getByRole("button", { name: /Configure/ }).click();
  const script = page.getByRole("combobox", { name: /Application and script/ });
  await script.click();
  await shot(page, "setup-scripts");
  await page.getByRole("option", { name: /^npm run dev \(.*\/fixtures\/vite\)$/ }).click();
  await expect(script).toContainText("npm run dev");
  await script.press("ArrowDown");
  await script.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Review/ }).click();
  await shot(page, "setup-review");
  await page.getByRole("button", { name: /Close review/ }).click();
  const next = app.waitForEvent("window", { timeout: 120_000 });
  await page.getByRole("button", { name: "Confirm & start", exact: true }).click();
  const workspace = await next;
  await expect(workspace.locator(".bridge-ready")).toHaveCount(2, { timeout: 120_000 });
  await expect.poll(async () => (await agent(workspace)).ready, { timeout: 60_000 }).toBe(true);
  await shot(workspace, "workspace");

  return workspace;
}

/** Closing opens the welcome window. The hidden audit window is a window too, so the next one is the window offering Open Project. */
async function leave(app: ElectronApplication, page: Page) {
  let next: Page | undefined;
  await closeProject(page);

  await expect.poll(async () => {
    for (const window of app.windows()) if (window !== page && await window.getByRole("button", { name: "Open Project", exact: true }).isVisible().catch(() => false)) next = window;

    return !!next;
  }, { timeout: 120_000 }).toBe(true);

  return next!;
}

/** Runs a full Electron session, collecting renderer console, page errors, failed loads, alerts and main-process stderr. */
async function collect(testInfo: TestInfo, renderer: Renderer, profile: (directory: string) => Promise<void>, flow: (app: ElectronApplication, shot: Shot) => Promise<void>) {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-console-clean-"));
  const log: Log = { messages: [], notices: [], phases: [], watched: new Set(), started: Date.now() };
  const directory = path.join(state, "config", "Mauxi", "pi-profile");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await profile(directory);
  const { MAUXI_RENDERER_URL: _packaged, ...inherited } = process.env;
  const env = { ...inherited, MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") };
  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: renderer === "dev" ? { ...env, MAUXI_RENDERER_URL: "http://127.0.0.1:44173" } : env });
  app.process().stderr?.on("data", (data: Buffer) => String(data).split("\n").filter(line => line.trim() && !harness.test(line)).forEach(line => record(log, log.messages, { source: "main", type: "stderr", text: line })));
  app.on("window", page => watch(page, log));
  watch(await app.firstWindow(), log);

  try {
    await flow(app, async (page, name) => {
      log.phases.push({ name, at: Date.now() - log.started });
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    });
  }
  finally {
    await app.close().catch(() => {});
    await rm(state, { recursive: true, force: true });
    await writeFile(testInfo.outputPath("console-messages.json"), JSON.stringify({ renderer, model: `${model.provider}/${model.id}`, live: !!liveAuth, count: log.messages.length, messages: log.messages, notices: log.notices, phases: log.phases }, null, 2));
  }

  expect(log.messages).toEqual([]);
}

for (const renderer of ["dev", "packaged"] as const) {
  test(`onboarding and chat finish without warnings or errors: ${renderer} renderer`, async ({}, testInfo) => {
    test.setTimeout(liveAuth ? 900_000 : 240_000);

    const server = createServer((request, response) => {
      let body = ""; request.on("data", data => { body += data; });
      request.on("end", () => {
        const sent = Value.Parse(ChatRequestSchema, JSON.parse(body)).messages;
        const prompt = JSON.stringify(sent.findLast(item => item.role === "user")?.content ?? "");
        const answered = sent.at(-1)?.role === "tool";

        if (prompt.includes(STOP_PROMPT)) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(chunk({ role: "assistant" }, null));

        return; }

        if (!answered && prompt.includes(TOOL_PROMPT)) return toolCall("workspace_read", JSON.stringify({ path: "package.json" }))(response, 0);

        if (!answered && (prompt.includes(COMMAND_PROMPT) || prompt.includes(DENY_PROMPT))) return toolCall("workspace_command", JSON.stringify({ executable: "node", args: ["--version"], cwd: path.resolve("fixtures/vite"), purpose: "Report the Node.js version" }))(response, 1);
        text(prompt.includes(TOOL_PROMPT) ? "@mauxi-fixture/vite" : prompt.includes(COMMAND_PROMPT) ? process.version : prompt.includes(DENY_PROMPT) ? "skipped" : "Ready.")(response, 2);
      });
    });

    const profile = async (directory: string) => {
      if (liveAuth) { await copyFile(liveAuth, path.join(directory, "auth.json")); await chmod(path.join(directory, "auth.json"), 0o600);

      return; }

      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { port } = Value.Parse(AddressSchema, server.address());
      await writeFile(path.join(directory, "models.json"), JSON.stringify({ providers: { [model.provider]: {
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-placeholder", api: "openai-completions",
        models: [{ id: model.id, name: model.name, reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } }));
    };

    try {
      await collect(testInfo, renderer, profile, async (app, shot) => {
        const page = await onboard(app, shot);
        const picker = page.getByRole("button", { name: "Models & providers", exact: true });
        await picker.click();
        const settings = page.getByRole("region", { name: "Models and providers", exact: true });
        await settings.getByRole("combobox", { name: "Model", exact: true }).click();
        await page.getByRole("searchbox", { name: "Search models" }).fill(model.name);
        await settings.getByRole("listbox", { name: "Model" }).getByRole("option", { name: new RegExp(model.name) }).first().click();
        await expect(picker).toContainText(model.name);
        await expect.poll(async () => (await agent(page)).selectedModel).toBe(`${model.provider}/${model.id}`);
        await picker.click();
        const thinking = settings.getByRole("group", { name: "Thinking level" });
        const level = (await agent(page)).models.find(item => item.key === `${model.provider}/${model.id}`)!.thinkingLevels.find(item => item !== "off") ?? "off";
        await thinking.getByRole("button", { name: level, exact: true }).click();
        await expect(thinking.getByRole("button", { name: level, exact: true })).toHaveAttribute("aria-pressed", "true");
        await shot(page, "model-settings");
        await settings.getByRole("button", { name: "Close models and providers", exact: true }).click();

        await send(page, "Reply with exactly one word: ready", "enter");
        await settle(page);
        await page.getByRole("button", { name: "Give agent control", exact: true }).click();
        await page.getByRole("button", { name: "Take back control", exact: true }).click();
        await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
        await selectTarget(page);
        await send(page, "In one short sentence, what is the selected element? Do not use tools.");
        await settle(page);
        await shot(page, "chat");
        await send(page, TOOL_PROMPT);
        await settle(page);
        await expect(page.getByRole("log", { name: "Agent response" })).toContainText("@mauxi-fixture/vite");
        await send(page, COMMAND_PROMPT);
        const approval = page.locator(".permission-dialog");
        await expect(approval).toBeVisible({ timeout: 120_000 });
        await expect(approval.getByLabel("Exact operation")).toContainText("--version");
        await shot(page, "approval");
        await approval.getByRole("button", { name: "Approve once", exact: true }).click();
        await settle(page);
        await expect(page.getByRole("log", { name: "Agent response" })).toContainText(process.version);
        await send(page, DENY_PROMPT);
        await expect(approval).toBeVisible({ timeout: 120_000 });
        await approval.getByRole("button", { name: "Deny", exact: true }).click();
        await settle(page);
        await expect(page.getByRole("log", { name: "Agent response" })).toContainText("skipped");
        await send(page, STOP_PROMPT);
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await expect.poll(async () => (await agent(page)).runState, { timeout: 60_000 }).toBe("idle");
        await expect(page.getByRole("log", { name: "Agent response" })).not.toContainText(/aborted/i);

        if (!liveAuth) await expect(page.getByRole("log", { name: "Agent response" })).toHaveText("Stopped before a response.");
        await shot(page, "stopped");
        await leave(app, page);
      });
    } finally { server.closeAllConnections(); server.close(); }
  });

  test(`first run without a provider, a cancelled sign-in and a reopen stay quiet: ${renderer} renderer`, async ({}, testInfo) => {
    test.setTimeout(240_000);
    await collect(testInfo, renderer, async () => {}, async (app, shot) => {
      const page = await onboard(app, shot);
      await page.getByRole("button", { name: "Models & providers", exact: true }).click();
      const settings = page.getByRole("region", { name: "Models and providers", exact: true });
      await expect(settings.getByRole("region", { name: "Provider list" })).toBeVisible();
      await shot(page, "providers");
      await settings.getByRole("button", { name: "Anthropic API key", exact: true }).click();
      const login = page.getByRole("dialog", { name: "Anthropic", exact: true });
      await expect(login.getByRole("textbox")).toBeVisible();
      await shot(page, "provider-login");
      await login.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(login).toHaveCount(0);
      await settings.getByRole("button", { name: "Refresh catalog", exact: true }).click();
      await expect(settings.getByRole("button", { name: "Refresh catalog", exact: true })).toBeEnabled({ timeout: 60_000 });
      await settings.getByRole("button", { name: "Close models and providers", exact: true }).click();
      await shot(page, "closing");
      const welcome = await leave(app, page);
      await shot(welcome, "closed");
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      await welcome.getByRole("button", { name: "Open Project", exact: true }).click();
      await expect(welcome.getByRole("button", { name: "Open Project", exact: true })).toBeEnabled();
      await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, path.resolve("."));
      await welcome.getByRole("button", { name: "Open Project", exact: true }).click();
      await expect(welcome.locator(".configure-trigger")).toContainText("npm run dev");
      const next = app.waitForEvent("window", { timeout: 120_000 });
      await welcome.getByRole("button", { name: "Confirm & start", exact: true }).click();
      const reopened = await next;
      await expect(reopened.locator(".bridge-ready")).toHaveCount(2, { timeout: 120_000 });
      await shot(reopened, "reopened");
      await leave(app, reopened);
    });
  });
}
