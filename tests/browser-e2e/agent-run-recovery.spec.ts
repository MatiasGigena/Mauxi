import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

interface ChatDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name?: string; arguments: string } }>;
}

type Reply = (response: ServerResponse, request: number) => void;

const chunk = (delta: ChatDelta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "recovery", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const toolCall = (name: string, args: string): Reply => (response, request) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${request}`, type: "function", function: { name, arguments: args } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
};

const text = (content: string): Reply => response => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
};

/** Starts a workspace_edit tool call, then never sends another byte. */
const stalledEdit: Reply = (response, request) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${request}`, type: "function", function: { name: "workspace_edit", arguments: "{\"path\":\"src/App.tsx\",\"oldText\":\"" } }] }, null));
};

const unavailable: Reply = response => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Service unavailable", type: "server_error" } }));
};

async function launch(state: string, replies: (request: number) => Reply, env: Record<string, string> = {}) {
  const requests: string[] = [];

  const server = createServer((request, response) => {
    let body = ""; request.on("data", data => { body += data; });
    request.on("end", () => { requests.push(body); replies(requests.length)(response, requests.length); });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = Value.Parse(Type.Object({ port: Type.Number() }), server.address());
  const profile = path.join(state, "config", "Mauxi", "pi-profile");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { "recovery-local": {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-placeholder", api: "openai-completions",
    models: [{ id: "recovery", name: "Recovery local fake", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(profile, "model-preference.json"), JSON.stringify({ defaultProvider: "recovery-local", defaultModel: "recovery" }));

  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, ...env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let page = await app.firstWindow();
  const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
  const plan = discovery.plans.find(candidate => candidate.appRoot.endsWith("/fixtures/vite"))!;
  const next = app.waitForEvent("window");
  await page.evaluate(request => window.mauxi!.confirmProject(request), { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" as const });
  page = await next;
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
  await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).selectedModel).toBe("recovery-local/recovery");

  const close = async () => {
    await app.close();
    server.closeAllConnections(); server.close();
  };

  return { page, requests, close };
}

async function handOffAndSend(page: Page, prompt: string) {
  await page.getByRole("button", { name: "Give agent control", exact: true }).click();
  await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const settled = (page: Page) => expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).runState, { timeout: 60_000 }).toBe("idle");
const snapshot = (page: Page) => page.evaluate(() => window.mauxi!.agentBootstrap());

test("malformed tool arguments are returned to the model without revoking preview control or failing the run", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("workspace_edit", JSON.stringify({ path: "src/App.tsx", oldText: "Mauxi", ".newText": "Mauxi!" })),
    toolCall("design_search", JSON.stringify({ query: "" })),
    toolCall("browser_targets", "{}"),
  ][request - 1] ?? text("Recovered from malformed arguments."));

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered from malformed arguments.", { timeout: 30_000 });
    await settled(page);
    expect(requests).toHaveLength(4);
    expect(requests[1]).toContain("Validation failed for tool \\\"workspace_edit\\\"");
    expect(requests[2]).toContain("Validation failed for tool \\\"design_search\\\"");
    expect(requests[3]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.locator(".send-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("malformed-arguments-recovered.png") });
  } finally { await close(); }
});

test("a turn-budget stop explains the limit instead of showing a raw abort", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, () => toolCall("workspace_list", "{}"));

  try {
    await handOffAndSend(page, "Keep exploring");
    const reason = "Stopped: the request reached its 40-turn limit; partial changes were kept for review.";
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText(reason, { timeout: 60_000 });
    await settled(page);
    expect(requests.length).toBeGreaterThanOrEqual(40);
    expect(requests.length).toBeLessThanOrEqual(41);
    const final = await snapshot(page);
    expect(final.error?.message).toBe(reason);
    await expect(page.getByText(/operation was aborted|Request was aborted/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("turn-budget-stop.png") });
  } finally { await close(); }
});

test("a stalled model stream is cut off and retried once", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, request => request === 1 ? stalledEdit : request === 2 ? toolCall("browser_targets", "{}") : text("Recovered after the stalled stream."), { MAUXI_TEST_STREAM_IDLE_MS: "2000" });

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered after the stalled stream.", { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.getByRole("log", { name: "Agent response" })).not.toContainText(/stopped sending data|timed out/i);
    await page.screenshot({ path: testInfo.outputPath("stalled-stream-retried.png") });
  } finally { await close(); }
});

test("a stream that stalls again ends with a clear reason", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, () => stalledEdit, { MAUXI_TEST_STREAM_IDLE_MS: "2000" });

  try {
    await handOffAndSend(page, "Polish the heading");
    const reason = "The model stopped sending data for 2 seconds (timed out).";
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText(reason, { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(2);
    expect((await snapshot(page)).error?.message).toBe(reason);
    await expect(page.getByText(/operation was aborted|Request was aborted/i)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("stalled-stream-failed.png") });
  } finally { await close(); }
});

test("a transient provider error is retried without revoking control or failing the run", async ({}, testInfo) => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));
  const { page, requests, close } = await launch(state, request => [unavailable, toolCall("browser_targets", "{}")][request - 1] ?? text("Recovered after the provider retry."));

  try {
    await handOffAndSend(page, "Polish the heading");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Recovered after the provider retry.", { timeout: 60_000 });
    await settled(page);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('\\"owner\\":\\"agent\\"');
    const final = await snapshot(page);
    expect(final.error).toBeUndefined();
    expect(final.status).toBe("Ready");
    await expect(page.locator(".send-error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("provider-retry-recovered.png") });
  } finally { await close(); }
});

test("malformed browser actions still return preview control to the user", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-"));

  const { page, requests, close } = await launch(state, request => [
    toolCall("browser_action", JSON.stringify({ previewId: "desktop", operation: "screenshot" })),
    toolCall("browser_targets", "{}"),
  ][request - 1] ?? text("Reported the revoked handoff."));

  try {
    await handOffAndSend(page, "Check the preview");
    await expect(page.getByRole("log", { name: "Agent response" })).toContainText("Reported the revoked handoff.", { timeout: 30_000 });
    await settled(page);
    expect(requests[1]).toContain("Validation failed for tool \\\"browser_action\\\"");
    expect(requests[2]).not.toContain('\\"owner\\":\\"agent\\"');
  } finally { await close(); }
});
