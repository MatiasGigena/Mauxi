import { _electron as electron, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ConfirmProjectRequest } from "../../src/application/project-contract";
import { entryAuditSettled } from "./entry-audit";

export interface ChatDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name?: string; arguments: string } }>;
}

export type Reply = (response: ServerResponse, request: number) => void;

export const chunk = (delta: ChatDelta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "recovery", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

export const toolCall = (name: string, args: string): Reply => (response, request) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${request}`, type: "function", function: { name, arguments: args } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
};

export const text = (content: string): Reply => response => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
};

/** Starts a workspace_edit tool call, then never sends another byte. */
export const stalledEdit: Reply = (response, request) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${request}`, type: "function", function: { name: "workspace_edit", arguments: "{\"path\":\"src/App.tsx\",\"oldText\":\"" } }] }, null));
};

export const unavailable: Reply = response => {
  response.writeHead(503, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Service unavailable", type: "server_error" } }));
};

export async function launch(state: string, replies: (request: number) => Reply, env: Record<string, string> = {}, startPath?: string, modelName = "Recovery local fake") {
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
    models: [{ id: "recovery", name: modelName, reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(profile, "model-preference.json"), JSON.stringify({ defaultProvider: "recovery-local", defaultModel: "recovery" }));

  const app = await electron.launch({ args: [path.resolve("dist-electron/main.js")], env: { ...process.env, ...env, MAUXI_TEST_MODE: "1", MAUXI_RENDERER_URL: "http://127.0.0.1:44173", MAUXI_STATE_DIR: path.join(state, "recovery"), XDG_CONFIG_HOME: path.join(state, "config") } });
  let page = await app.firstWindow();
  const discovery = await page.evaluate(root => window.mauxi!.inspectProjectPath(root), path.resolve("."));
  const plan = discovery.plans.find(candidate => candidate.appRoot.endsWith("/fixtures/vite"))!;
  const next = app.waitForEvent("window");
  const confirm: ConfirmProjectRequest = { discoveryId: discovery.discoveryId, planId: plan.id, mode: "start" };

  if (startPath) confirm.startPath = startPath;
  await page.evaluate(request => window.mauxi!.confirmProject(request), confirm);
  page = await next;
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 45_000 });
  await expect.poll(async () => (await page.evaluate(() => window.mauxi!.agentBootstrap())).selectedModel).toBe("recovery-local/recovery");
  // Every opened workspace audits its start page first; tests begin once that run has finished.
  await entryAuditSettled(page);

  const close = async () => {
    await app.close();
    server.closeAllConnections(); server.close();
  };

  return { page, requests, close };
}
