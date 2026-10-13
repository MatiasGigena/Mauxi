import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectionContext } from "../../src/application/agent-contract";
import type { StoredSelection } from "../../src/application/selection-state";
import { PiAgentHost } from "../../src/infrastructure/agent/pi-agent-host";

const temporary: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeout = 6_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for fake provider state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function selection(): StoredSelection {
  return {
    status: "current",
    capture: {
      workspaceId: "workspace-1", previewId: "desktop", selectionId: "selection-1",
      documentGeneration: "generation", url: "http://127.0.0.1:4000/account", capturedAt: "2026-01-01T00:00:00.000Z",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 }, bounds: { x: 10, y: 20, width: 200, height: 40 },
      element: { tag: "button", label: "Save", text: "Save", html: `<button>${"x".repeat(10_000)}</button>` },
      domAncestry: [], componentOwners: [], computedStyles: { color: "red" },
      fingerprint: { instanceKey: "one", tag: "button", sourceKey: "src/App.tsx:4:2", text: "Save" },
      source: { filePath: "src/App.tsx", fileFingerprint: "abc", lineNumber: 4, columnNumber: 2, method: "react-grab", ownership: "application", verification: "verified", role: "jsx-element" },
      support: { status: "supported" }, screenshot: { status: "unavailable", crop: { x: 10, y: 20, width: 200, height: 40, space: "preview-css-pixels" }, reason: "test" },
    },
  } as unknown as StoredSelection;
}

describe("agent request context", () => {
  it("keeps preview identity, source fingerprints and bounded DOM in one inspectable block", () => {
    const context = selectionContext([selection()]);
    expect(context).toContain("Selection 1 [desktop]");
    expect(context).toContain("src/App.tsx:4:2 (SHA-256 abc)");
    expect(context).toContain("1280x720");
    expect(context.length).toBeLessThan(9_000);
  });
});

describe("bundled pi host", () => {
  it("initializes an app-owned profile without a pi CLI and keeps one runtime across callers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-agent-test-")); temporary.push(root);
    const profile = path.join(root, "profile");
    const host = new PiAgentHost("workspace-1", process.cwd(), profile, path.join(root, "captures"));
    await Promise.all([host.initialize(), host.initialize()]);
    const first = await host.snapshot();
    const second = await host.snapshot();
    expect(first.ready).toBe(true);
    expect(first.providers.length).toBeGreaterThan(0);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.workspaceId).toBe("workspace-1");
    await expect(host.send({ workspaceId: "workspace-1", text: "hello", behavior: "prompt", selections: [] })).rejects.toThrow(/model/i);
    await host.dispose();
  });

  it("restores the last selected provider/model after restart and across workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-model-restart-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile);
    const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: {
      fake: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", api: "openai-completions", models: [model("one"), model("vendor/two")] },
      other: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", api: "openai-completions", models: [model("vendor/two")] },
    } }));
    const createHost = (workspace: string) => new PiAgentHost(workspace, process.cwd(), profile, path.join(root, "captures"));
    const host = createHost("workspace-1");
    try {
      await host.initialize();
      await host.selectModel({ workspaceId: "workspace-1", modelKey: "fake/vendor/two" });
    } finally { await host.dispose(); }
    const restarted = createHost("workspace-2");
    try {
      await restarted.initialize();
      expect((await restarted.snapshot()).selectedModel).toBe("fake/vendor/two");
      await restarted.newSession("workspace-2");
      expect((await restarted.snapshot()).selectedModel).toBe("fake/vendor/two");
      await expect(restarted.selectModel({ workspaceId: "workspace-2", modelKey: "fake/missing" })).rejects.toThrow(/Authenticate/);
      await restarted.selectModel({ workspaceId: "workspace-2", modelKey: "other/vendor/two" });
    } finally { await restarted.dispose(); }
    const latest = createHost("workspace-1");
    try {
      await latest.initialize();
      expect((await latest.snapshot()).selectedModel).toBe("other/vendor/two");
      await expect(latest.selectModel({ workspaceId: "workspace-1", modelKey: "fake/missing" })).rejects.toThrow(/Authenticate/);
    } finally { await latest.dispose(); }
    const afterInvalidChoice = createHost("workspace-1");
    try {
      await afterInvalidChoice.initialize();
      expect((await afterInvalidChoice.snapshot()).selectedModel).toBe("other/vendor/two");
    } finally { await afterInvalidChoice.dispose(); }
  });

  it("lets initialization be retried after a failure that occurs before the runtime exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-init-retry-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile);
    await writeFile(path.join(profile, "checkpoints"), "not a directory");
    const host = new PiAgentHost("workspace-1", process.cwd(), profile, path.join(root, "captures"));
    try {
      await expect(host.initialize()).rejects.toThrow();
      await rm(path.join(profile, "checkpoints"));
      await host.initialize();
      expect((await host.snapshot()).ready).toBe(true);
    } finally { await host.dispose(); }
  });

  it("retires a request checkpoint whose activation fails instead of leaving it prepared", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-activation-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile);
    const project = path.join(root, "project"); await mkdir(project);
    await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: {
      fake: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", api: "openai-completions", models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    const host = new PiAgentHost("workspace-1", project, profile, path.join(root, "captures"));
    try {
      await host.initialize();
      await host.selectModel({ workspaceId: "workspace-1", modelKey: "fake/one" });
      const changes = (host as unknown as { changes: { prepare: (label: string) => Promise<string>; activate: (id: string) => Promise<void> } }).changes;
      await changes.activate(await changes.prepare("Already running"));
      for (const behavior of ["prompt", "followUp"] as const) {
        await expect(host.send({ workspaceId: "workspace-1", text: `blocked ${behavior}`, behavior, selections: [] })).rejects.toThrow(/Another request checkpoint is active/);
      }
      const sets = (await host.snapshot()).changeSets.filter((set) => set.label.startsWith("blocked"));
      expect(sets).toHaveLength(2);
      expect(sets.every((set) => set.state === "failed")).toBe(true);
    } finally { await host.dispose(); }
  });

  it("allows undo after a prompt is rejected before its run starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-undo-after-reject-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile);
    const project = path.join(root, "project"); await mkdir(project);
    await writeFile(path.join(project, "a.txt"), "before");
    await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: {
      fake: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", api: "openai-completions", models: [{ id: "one", name: "one", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    const host = new PiAgentHost("workspace-1", project, profile, path.join(root, "captures"));
    try {
      await host.initialize();
      await host.selectModel({ workspaceId: "workspace-1", modelKey: "fake/one" });
      const internals = host as unknown as { changes: { prepare: (label: string) => Promise<string>; activate: (id: string) => Promise<void>; write: (file: string, content: string) => Promise<unknown>; settle: () => Promise<void> }; runtime: { session: { prompt: (...args: unknown[]) => Promise<void> } } };
      const id = await internals.changes.prepare("Agent edit"); await internals.changes.activate(id);
      await internals.changes.write("a.txt", "after"); await internals.changes.settle();
      const prompt = vi.spyOn(internals.runtime.session, "prompt").mockRejectedValue(new Error("No API key found for fake"));
      try {
        expect(await host.send({ workspaceId: "workspace-1", text: "rejected", behavior: "prompt", selections: [] })).toEqual({ accepted: false });
      } finally { prompt.mockRestore(); }
      expect((await host.snapshot()).runState).toBe("error");
      await host.undo({ workspaceId: "workspace-1", changeSetId: id });
      expect(await readFile(path.join(project, "a.txt"), "utf8")).toBe("before");
    } finally { await host.dispose(); }
  });

  it("falls back safely when the saved model is unavailable without erasing the preference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-model-unavailable-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile);
    await writeFile(path.join(profile, "model-preference.json"), JSON.stringify({ defaultProvider: "missing", defaultModel: "missing" }));
    const host = new PiAgentHost("workspace-1", process.cwd(), profile, path.join(root, "captures"));
    try {
      await host.initialize();
      expect((await host.snapshot()).selectedModel).toBeUndefined();
    } finally { await host.dispose(); }
    const { loadModelPreference } = await import("../../src/infrastructure/agent/model-preference");
    expect(await loadModelPreference(profile)).toEqual({ defaultProvider: "missing", defaultModel: "missing" });
  });

  it("streams a fake provider, adapts a structured question, queues input, stops, and resumes", async () => {
    let requests = 0; let expired = false;
    let holdFirstText = true;
    let releaseFirstResponse: (() => void) | undefined;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requests += 1;
        if (expired) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Expired API credential", type: "authentication_error" } })); return; }
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
        const messages = parsed.messages ?? [];
        const hasToolResult = messages.some((message) => message.role === "tool");
        const userText = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join(" ");
        response.writeHead(200, { "content-type": "text/event-stream" });
        const push = (value: unknown) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`); };
        const base = { id: `fake-${requests}`, object: "chat.completion.chunk", created: 1, model: "fake" };
        push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        if (userText.includes("structured question") && !hasToolResult) {
          push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "question-1", type: "function", function: { name: "ask_question", arguments: JSON.stringify({ question: "Choose a color", options: [{ id: "blue", label: "Blue" }] }) } }] }, finish_reason: null }] });
          push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          response.end("data: [DONE]\n\n");
          return;
        }
        const text = hasToolResult ? "You chose blue." : userText.includes("slow response") ? "This should be stopped." : `Fake response ${requests}`;
        push({ ...base, choices: [{ index: 0, delta: { content: text.slice(0, 4) }, finish_reason: null }] });
        const delay = userText.includes("slow response") ? 1_000 : 25;
        const finish = () => {
          push({ ...base, choices: [{ index: 0, delta: { content: text.slice(4) }, finish_reason: null }] });
          push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
          if (!response.destroyed) response.end("data: [DONE]\n\n");
        };
        if (holdFirstText) {
          // A 25ms pause can coalesce both chunks under load. Hold the first
          // response until a public partial snapshot actually arrives.
          holdFirstText = false;
          const timeout = setTimeout(finish, 5_000);
          releaseFirstResponse = () => { clearTimeout(timeout); finish(); };
        } else setTimeout(finish, delay);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake provider did not bind");

    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-fake-agent-")); temporary.push(root);
    const profile = path.join(root, "profile"); await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { fake: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-initial-secret", api: "openai-completions",
      models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const host = new PiAgentHost("workspace-1", process.cwd(), profile, path.join(root, "captures"));
    let latest = await host.initialize().then(() => host.snapshot());
    let sawPartial = false; let sawWorking = false; let sawQuestion = false; let authResponse: "cancel" | "success" | null = null;
    const off = host.subscribe((event) => {
      if (event.type === "snapshot") {
        latest = event.snapshot;
        sawWorking ||= event.snapshot.runState === "working";
        sawPartial ||= event.snapshot.messages.some((message) => message.pending && message.role === "assistant" && message.text.length > 0);
        if (sawPartial && releaseFirstResponse) {
          const release = releaseFirstResponse; releaseFirstResponse = undefined; release();
        }
      }
      if (event.type === "dialog" && event.dialog.kind === "select") {
        sawQuestion = true;
        host.respondToDialog({ workspaceId: "workspace-1", dialogId: event.dialog.id, value: "blue" });
      }
      if (event.type === "dialog" && event.dialog.kind === "secret" && authResponse) {
        host.respondToDialog({ workspaceId: "workspace-1", dialogId: event.dialog.id, ...(authResponse === "cancel" ? { cancelled: true } : { value: "replacement-fake-secret" }) });
      }
    });
    authResponse = "cancel";
    await expect(host.login({ workspaceId: "workspace-1", providerId: "fake", type: "api_key" })).rejects.toThrow(/cancel/i);
    authResponse = "success";
    await host.login({ workspaceId: "workspace-1", providerId: "fake", type: "api_key" });
    authResponse = null;
    expect(JSON.stringify(await host.snapshot())).not.toContain("replacement-fake-secret");
    await host.selectModel({ workspaceId: "workspace-1", modelKey: "fake/fake" });
    expect(await host.send({ workspaceId: "workspace-1", text: "Run a structured question", behavior: "prompt", selections: [] })).toEqual({ accepted: true });
    await waitFor(() => latest.runState === "idle" && latest.messages.some((message) => message.text.includes("You chose blue")));
    // Public snapshots expose response text as it streams, never reasoning.
    expect(sawWorking).toBe(true);
    expect(sawPartial).toBe(true);
    expect(sawQuestion).toBe(true);

    expect(await host.send({ workspaceId: "workspace-1", text: "queue work", behavior: "prompt", selections: [] })).toEqual({ accepted: true });
    await host.send({ workspaceId: "workspace-1", text: "steering note", behavior: "steer", selections: [] });
    await host.send({ workspaceId: "workspace-1", text: "follow-up note", behavior: "followUp", selections: [] });
    await host.send({ workspaceId: "workspace-1", text: "follow-up note", behavior: "followUp", selections: [] });
    await waitFor(() => latest.runState === "idle" && latest.messages.filter((message) => message.role === "user").length >= 5
      && latest.changeSets.filter((set) => set.label === "follow-up note").every((set) => set.state !== "prepared"));
    const duplicateFollowUps = latest.changeSets.filter((set) => set.label === "follow-up note");
    expect(duplicateFollowUps).toHaveLength(2);
    expect(duplicateFollowUps.every((set) => set.state !== "prepared")).toBe(true);

    const oldSession = latest.sessionId!;
    await host.rename({ workspaceId: "workspace-1", name: "Fake conversation" });
    await host.newSession("workspace-1");
    expect((await host.snapshot()).sessionId).not.toBe(oldSession);
    await host.resume({ workspaceId: "workspace-1", sessionId: oldSession });
    expect((await host.snapshot()).messages.some((message) => message.text.includes("structured question"))).toBe(true);

    expect(await host.send({ workspaceId: "workspace-1", text: "slow response", behavior: "prompt", selections: [] })).toEqual({ accepted: true });
    await waitFor(() => latest.runState === "working");
    await host.stop("workspace-1");
    await waitFor(() => latest.runState === "idle");

    const visual = selection();
    visual.capture.screenshot = { ...visual.capture.screenshot, status: "captured", path: path.join(root, "captures", "selection.png"), width: 20, height: 20 };
    await expect(host.send({ workspaceId: "workspace-1", text: "see this", behavior: "prompt", selections: [visual] })).rejects.toThrow(/cannot see image/i);
    expired = true;
    await host.send({ workspaceId: "workspace-1", text: "Expired authentication probe", behavior: "prompt", selections: [] });
    await waitFor(() => latest.runState === "idle" && latest.error?.kind === "auth");
    expect(latest.error?.message).toContain("sign in again");
    expect(JSON.stringify(latest)).not.toContain("replacement-fake-secret");
    expired = false; authResponse = "success";
    await host.login({ workspaceId: "workspace-1", providerId: "fake", type: "api_key" });
    authResponse = null;
    await host.newSession("workspace-1");
    await host.send({ workspaceId: "workspace-1", text: "Recovered authentication", behavior: "prompt", selections: [] });
    await waitFor(() => latest.runState === "idle" && latest.messages.some(message => message.text.includes("Fake response")));
    expect(latest.error).toBeUndefined();
    // Exercise the host's adapter to an SDK catalog failure without consulting
    // a live catalog or relying on external service availability.
    const runtime = (host as unknown as { modelRuntime: { refresh: (...args: any[]) => Promise<any> } }).modelRuntime;
    const models = latest.models.map(model => model.key);
    const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({ errors: new Map([["fake", new Error("offline")]]), aborted: false });
    try {
      await host.refreshCatalog("workspace-1");
      const cached = await host.snapshot();
      expect(cached.error?.kind).toBe("catalog");
      expect(cached.models.map(model => model.key)).toEqual(models);
      refresh.mockResolvedValue({ errors: new Map(), aborted: true });
      await host.refreshCatalog("workspace-1");
      expect((await host.snapshot()).error?.message).toContain("timed out");
    } finally { refresh.mockRestore(); }
    off(); await host.dispose();
  });
});
