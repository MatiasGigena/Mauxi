import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PiAgentHost } from "../../src/infrastructure/agent/pi-agent-host";
import type { AgentSnapshot } from "../../src/application/agent-contract";

interface CompletionDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }>;
}

const ServerAddress = Type.Object({ port: Type.Integer() });

it.each([false, true])("runs the automatic library and approved native guidance through the real SDK (bundled skills: %s)", async (bundled) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-design-workflow-"));
  const project = path.join(root, "project"); const profile = path.join(root, "profile");
  await mkdir(path.join(project, ".pi", "extensions"), { recursive: true }); await mkdir(profile);
  await writeFile(path.join(project, ".pi", "extensions", "unsafe.ts"), 'throw new Error("AMBIENT_EXTENSION_EXECUTED")');
  await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:mauxi-must-never-install-missing-package"], extensions: ["./extensions/unsafe.ts"] }));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];

  const server = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body); requests.push(parsed);
      const lastUser = parsed.messages.findLastIndex((message: { role: string; content: unknown }) => message.role === "user" && JSON.stringify(message.content).includes("[Mauxi request]"));
      const results = parsed.messages.slice(lastUser).filter((message: { role: string }) => message.role === "tool");
      const content = JSON.stringify(parsed.messages[lastUser]?.content);

      const tools = [
        { name: "design_search", arguments: JSON.stringify({ query: "light serif hero", viewport: "mobile" }) },
        { name: "design_image", arguments: JSON.stringify({ id: "meridian-01-hero", viewport: "mobile" }) },
        { name: "design_read", arguments: JSON.stringify({ name: "mobile-native" }) },
        ...(content.includes("3 variants of this header") ? [
          { name: "design_read", arguments: JSON.stringify({ name: "prototype" }) },
          { name: "design_read", arguments: JSON.stringify({ name: "apple-design" }) },
          { name: "design_read", arguments: JSON.stringify({ name: "emil-design-eng" }) },
          { name: "design_read", arguments: JSON.stringify({ name: "prototype", file: "PICKER.md" }) },
        ] : []),
      ];

      response.writeHead(200, { "content-type": "text/event-stream" });
      const push = (delta: CompletionDelta, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      push({ role: "assistant", content: "" });

      if (content.includes("inspect examples") && results.length < tools.length) {
        push({ content: "Loading mobile-native and design references." });
        push({ tool_calls: [{ index: 0, id: `tool-${results.length}`, type: "function", function: tools[results.length] }] });
        push({}, "tool_calls");
      } else { push({ content: "Layout checked. Real device behavior remains unverified." }); push({}, "stop"); }

      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!Value.Check(ServerAddress, address)) throw new Error("No server");
  await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test", api: "openai-completions", models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const host = new PiAgentHost("design", project, profile, path.join(root, "captures"), undefined, undefined, undefined, path.resolve("design-references/library/catalog.json"), bundled ? path.resolve("design-skills") : undefined);
  let latest: AgentSnapshot; let consent = false; let sawApproval = false;

  const off = host.subscribe((event) => {
    if (event.type === "snapshot") latest = event.snapshot;

    if (event.type === "dialog") { sawApproval = true; host.respondToDialog({ workspaceId: "design", dialogId: event.dialog.id, ...(consent ? { value: "approve" } : { cancelled: true }) }); }
  });

  const waitIdle = async () => {
    for (let n = 0; n < 500; n++) {
      if (latest?.runState === "idle" && latest.messages.some((message) => message.role === "assistant")) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error("Agent did not settle");
  };

  try {
    await host.initialize();
    expect(host.diagnostics().resources?.catalog).toMatchObject({ count: 10, enabled: true });
    expect(sawApproval).toBe(false);

    if (bundled) {
      expect(host.diagnostics().resources?.skills.filter((skill) => skill.loaded)).toHaveLength(4);
      await host.selectModel({ workspaceId: "design", modelKey: "fake/fake" });
      await host.send({ workspaceId: "design", text: "I need you to give me 3 variants of this header; inspect examples", behavior: "prompt", selections: [] });
      await waitIdle();
      expect(JSON.stringify(requests[0].messages)).toContain("Guidance: prototype");
      expect(JSON.stringify(requests[0].messages)).toContain("Guidance: apple-design");
      expect(JSON.stringify(requests[0].messages)).toContain("File: PICKER.md");
      const snapshot = await host.snapshot();
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.status).toBe("Ready");
      expect(sawApproval).toBe(false);
      const results = requests.at(-1)!.messages.filter((message) => message.role === "tool");
      expect(results).toHaveLength(7);
      expect(JSON.stringify(results)).toContain("# The Picker");
      expect(JSON.stringify(results)).not.toContain("unavailable or disabled");
      await host.newSession("design");
      requests.length = 0;
    }

    const source = path.join(root, "mobile-native"); await mkdir(source);
    const sourceFile = path.join(source, "SKILL.md");
    const original = "---\nname: mobile-native\ndescription: Mobile layout guidance\ndisable-model-invocation: true\n---\nUNIQUE_LOADED_BODY: Preserve the project tokens and never disable zoom.\nSee [details](DETAILS.md).\n";
    await writeFile(sourceFile, original);
    await writeFile(path.join(source, "DETAILS.md"), "UNIQUE_DEPENDENCY_BODY: Use readable mobile inputs.");
    await expect(host.importResource({ workspaceId: "design", kind: "skill", path: sourceFile })).rejects.toThrow(/cancelled/);
    expect(host.diagnostics().resources?.skills).toHaveLength(bundled ? 4 : 0);
    consent = true;
    await host.importResource({ workspaceId: "design", kind: "skill", path: sourceFile });
    expect(sawApproval).toBe(true);
    const replacementDirectory = path.join(root, "replacement"); await mkdir(replacementDirectory);
    const catalogPath = path.resolve("design-references/library/catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const replacementPath = path.join(replacementDirectory, "catalog.json");
    await writeFile(replacementPath, JSON.stringify({ version: 1, references: [{ ...catalog.references[0], id: "new-reviewed-entry" }] }));
    consent = false;
    await expect(host.importResource({ workspaceId: "design", kind: "catalog", path: replacementPath })).rejects.toThrow(/cancelled/);
    expect(host.diagnostics().resources?.catalog).toMatchObject({ path: catalogPath, count: 10 });
    consent = true;
    expect(host.diagnostics().resources?.skills[0].loaded).toBe(true);
    expect(await readFile(sourceFile, "utf8")).toBe(original);
    await host.selectModel({ workspaceId: "design", modelKey: "fake/fake" });
    await host.send({ workspaceId: "design", text: "Improve mobile hero; inspect examples", behavior: "prompt", selections: [] });
    await waitIdle();
    expect(JSON.stringify(requests[0].tools)).toContain("design_search");
    expect(JSON.stringify(requests[0].tools)).toContain("design_image");
    expect(JSON.stringify(requests[0].tools)).toContain("design_read");
    expect(JSON.stringify(requests[0].messages)).toContain("UNIQUE_LOADED_BODY");
    expect(JSON.stringify(requests[0].messages)).toContain("UNIQUE_DEPENDENCY_BODY");
    expect(JSON.stringify(requests[0].messages)).toContain("Preserve the target project's framework");
    expect(JSON.stringify(requests)).toContain("data:image/webp;base64,");
    const snapshot = await host.snapshot();
    expect(snapshot.messages.find((message) => message.role === "user")?.text).toBe("Improve mobile hero; inspect examples");
    expect(snapshot.messages.some((message) => /Loading mobile-native|mauxi_guidance|design references|Used design_/.test(message.text))).toBe(false);
    expect(host.diagnostics().tools.some((tool) => tool.name.startsWith("design_"))).toBe(false);
    expect(snapshot.error).toBeUndefined();
    await host.newSession("design");
    await host.send({ workspaceId: "design", text: "/skill:mobile-native check this", behavior: "prompt", selections: [] });
    await waitIdle();
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("UNIQUE_LOADED_BODY");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("UNIQUE_DEPENDENCY_BODY");
    expect((await host.snapshot()).messages[0].text).toBe("/skill:mobile-native check this");
    await host.toggleResource({ workspaceId: "design", name: "mobile-native", enabled: false });
    await host.newSession("design");
    await expect(host.send({ workspaceId: "design", text: "/mobile-native check this", behavior: "prompt", selections: [] })).rejects.toThrow(/unavailable/);
    await host.send({ workspaceId: "design", text: "Improve mobile spacing", behavior: "prompt", selections: [] });
    await waitIdle();
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("UNIQUE_LOADED_BODY");
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("UNIQUE_DEPENDENCY_BODY");
    await host.newSession("design");
    await host.send({ workspaceId: "design", text: "inspect examples", behavior: "prompt", selections: [] });
    await waitIdle();
    expect((await host.snapshot()).error?.message).toContain("requested skill is unavailable");
    expect((await host.snapshot()).error?.message).not.toMatch(/image|Agent settings/);
  } finally {
    off(); await host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("rejects approval when there is no connected desktop and rejects unsupported imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-no-ui-"));
  const project = path.join(root, "project"); await mkdir(project);
  const host = new PiAgentHost("none", project, path.join(root, "profile"), path.join(root, "captures"));

  try {
    await host.initialize();
    await expect(host.importResource({ workspaceId: "none", kind: "skill", path: "npm:unknown" })).rejects.toThrow(/unsupported/);
    await mkdir(path.join(root, "source"));
    const file = path.join(root, "source/SKILL.md");
    await writeFile(file, "---\nname: apple-design\ndescription: UI craft\n---\nPreserve conventions");
    await expect(host.importResource({ workspaceId: "none", kind: "skill", path: file })).rejects.toThrow(/approval unavailable/);
    expect(host.diagnostics().resources?.skills).toHaveLength(0);
  } finally { await host.dispose(); await rm(root, { recursive: true, force: true }); }
});
