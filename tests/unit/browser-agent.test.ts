import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PiAgentHost } from "../../src/infrastructure/agent/pi-agent-host";
import { BrowserControl } from "../../src/application/browser-control";
import type { BrowserRequest, BrowserTarget } from "../../src/application/browser-contract";

interface CompletionDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }>;
}

const ServerAddress = Type.Object({ port: Type.Integer() });

it.each(["model-error", "stop", "disconnect"])("real SDK browser tool plumbing returns control after %s without a paid model", async scenario => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-browser-sdk-"));
  const project = path.join(root, "project"), profile = path.join(root, "profile"); await mkdir(project); await mkdir(profile);
  const calls: BrowserRequest[] = []; const requests: any[] = [];
  const targets: BrowserTarget[] = (["desktop", "mobile"] as const).map(previewId => ({ workspaceId: "test", previewId, documentId: `document-${previewId}`, url: "http://127.0.0.1:3000/" }));
  let host: PiAgentHost;

  const browser = new BrowserControl("test", {
    targets: async () => targets,
    describeTarget: async () => ({ tag: "button", text: "Delete fixture record", label: "Delete fixture record", role: "button", testId: "delete-record", type: "button", bounds: { x: 20, y: 30, width: 100, height: 40 } }),
    execute: async request => { calls.push(request);

    return request.operation === "screenshot" ? { text: `Actual ${request.previewId} fixture capture`, image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=" } : { text: `Observed ${request.previewId} current state` }; },
  }, (request, signal, target) => host.approveBrowserAction(request, signal, target));

  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body); requests.push(parsed);

      if (scenario === "model-error") { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Deterministic model failure", type: "invalid_request_error" } }));

      return; }

      const results = parsed.messages.filter((m: any) => m.role === "tool");
      const tools = [{ name: "browser_action", arguments: JSON.stringify({ ...targets[0], generation: browser.state().generation, operation: "click", target: "1" }) }];

      response.writeHead(200, { "content-type": "text/event-stream" });
      const push = (delta: CompletionDelta, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      push({ role: "assistant", content: "" });

      if (results.length < tools.length) { push({ tool_calls: [{ index: 0, id: `tool-${results.length}`, type: "function", function: tools[results.length] }] }); push({}, "tool_calls"); }
      else { push({ content: "Desktop and mobile DOM and fixture screenshots checked. User journeys, real devices and external effects remain unverified." }); push({}, "stop"); }

      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!Value.Check(ServerAddress, address)) throw new Error("No server");
  await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-local-only", api: "openai-completions", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  host = new PiAgentHost("test", project, profile, path.join(root, "captures"), undefined, browser);
  let dialog = false; let finished = false; let approvalMessage = ""; let approvalOperation = "";

  const off = host.subscribe(event => {
    if (event.type === "dialog") {
      dialog = true; approvalMessage = event.dialog.message;

      if (event.dialog.kind === "approval") approvalOperation = event.dialog.operation;
    }

    if (event.type === "snapshot" && requests.length && event.snapshot.runState === "idle") finished = true;
  });

  try {
    await host.initialize(); await host.selectModel({ workspaceId: "test", modelKey: "fake/fake" }); browser.grant();
    await host.send({ workspaceId: "test", text: "Verify both visible previews", behavior: "prompt", selections: [] });

    if (scenario === "stop" || scenario === "disconnect") {
      await vi.waitFor(() => expect(dialog).toBe(true), { timeout: 5000 });
      expect(approvalMessage).toContain("<button> Delete fixture record");
      expect(JSON.parse(approvalOperation).resolvedTarget).toMatchObject({ tag: "button", testId: "delete-record", bounds: { x: 20, y: 30 } });

      if (scenario === "stop") await host.stop("test"); else off();
      await vi.waitFor(() => expect(browser.state()).toMatchObject({ owner: "human", releasing: false }));
      expect(calls).toHaveLength(0);
      expect(server.listening).toBe(true);
    } else {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5000 });
      expect(browser.state().owner).toBe("human");
      expect(calls).toHaveLength(0);
    }
  } finally { off(); await host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 15_000);
