import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../src/application/agent-contract";
import { executeCommand, PiAgentHost } from "../../src/infrastructure/agent/pi-agent-host";

const temporary: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeout = 5_000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error("Timed out waiting for command agent"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

async function missing(file: string) { try { await access(file); return false; } catch { return true; } }

describe("host-side command approval", () => {
  it.each(["timeout", "abort", "early-exit", "early-exit-closed-pipes", "escaped-pipes"])("bounds command completion and cleans ordinary descendants (%s)", async (scenario) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-tree-")); temporary.push(directory);
    const handle = await open(directory, "r");
    const descendant = "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync('ready.pid',String(process.pid)); setInterval(()=>fs.appendFileSync('mutations.txt','x'),10)";
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${scenario === "early-exit-closed-pipes" ? "'ignore'" : "['ignore','inherit','inherit']"},detached:${scenario === "escaped-pipes"}}); ${scenario === "timeout" || scenario === "abort" ? "setInterval(()=>{},1000)" : "const timer=setInterval(()=>{if(fs.existsSync('ready.pid')){clearInterval(timer);child.unref();process.exit(7)}},5)"}`;
    let pid: number | undefined;
    const start = Date.now();
    try {
      const controller = new AbortController();
      const result = executeCommand(process.execPath, ["-e", script], handle, { timeoutMs: scenario === "abort" ? 120_000 : 600, killGraceMs: 150 }, controller.signal);
      if (scenario === "abort") {
        const assertion = expect(result).rejects.toThrow(/cancelled/);
        while (await missing(path.join(directory, "ready.pid"))) {
          if (Date.now() - start > 2_000) throw new Error("Descendant failed to start");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        controller.abort(); await assertion;
      } else if (scenario === "timeout") await expect(result).rejects.toThrow(/timed out/);
      else expect((await result).exitCode).toBe(7);
      expect(Date.now() - start).toBeLessThan(2_500);
      pid = Number(await readFile(path.join(directory, "ready.pid"), "utf8"));
      if (scenario !== "escaped-pipes") {
        // A killed orphan may briefly remain a zombie until init reaps it.
        const deadline = Date.now() + 2_000;
        while (true) {
          const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
          if (!status || status.slice(status.lastIndexOf(")") + 2).startsWith("Z")) break;
          if (Date.now() > deadline) throw new Error(`Descendant ${pid} is still running`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const writes = await readFile(path.join(directory, "mutations.txt"), "utf8").catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await readFile(path.join(directory, "mutations.txt"), "utf8").catch(() => "")).toBe(writes);
      }
    } finally {
      if (!pid) pid = Number(await readFile(path.join(directory, "ready.pid"), "utf8").catch(() => "0"));
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await handle.close();
    }
  });

  it("fingerprints commands whose ordinary text arguments cannot name a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-fingerprint-")); temporary.push(root);
    const project = path.join(root, "project"); await mkdir(project);
    await writeFile(path.join(project, "package.json"), "{}");
    await symlink("loop", path.join(project, "loop"));
    const host = new PiAgentHost("workspace-1", project, path.join(root, "profile"), path.join(root, "captures"));
    const fingerprint = (host as unknown as { commandConfigurationFingerprint: (operation: { executable: string; args: string[]; cwd: string }) => Promise<string> }).commandConfigurationFingerprint.bind(host);
    const cwd = await realpath(project);
    // A long commit message or inline script is not a path; neither is a symlink loop.
    await expect(fingerprint({ executable: "git", args: ["commit", "-m", "x".repeat(300)], cwd })).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(fingerprint({ executable: "cat", args: ["loop"], cwd })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not spawn a command with an already aborted signal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-aborted-")); temporary.push(directory);
    const handle = await open(directory, "r");
    try {
      await expect(executeCommand(process.execPath, ["-e", "require('node:fs').writeFileSync('ran', 'bad')"], handle, undefined, AbortSignal.abort())).rejects.toThrow(/abort/i);
      expect(await missing(path.join(directory, "ran"))).toBe(true);
    } finally { await handle.close(); }
  });

  it("drains normal output, bounds noisy output, and preserves exit/error semantics", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-output-")); temporary.push(directory);
    const handle = await open(directory, "r");
    try {
      expect(await executeCommand(process.execPath, ["-e", "process.stdout.write('normal');process.exitCode=3"], handle)).toEqual({ output: "normal", exitCode: 3 });
      const noisy = await executeCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], handle);
      expect(noisy.output.length).toBe(120_000); expect(noisy.exitCode).toBe(0);
      await expect(executeCommand(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], handle)).rejects.toThrow(/SIGTERM/);
      await expect(executeCommand("/nonexistent-mauxi-executable", [], handle)).rejects.toThrow(/ENOENT/);
    } finally { await handle.close(); }
  });

  it("anchors spawn to the approved directory inode despite a last-moment cwd symlink swap", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-cwd-")); temporary.push(directory);
    const approved = path.join(directory, "approved"); const moved = path.join(directory, "moved"); const outside = path.join(directory, "outside");
    await mkdir(approved); await mkdir(outside);
    const handle = await open(approved, "r");
    try {
      await rename(approved, moved); await symlink(outside, approved);
      const result = await executeCommand(process.execPath, ["-e", "require('node:fs').writeFileSync('result.txt', 'approved inode')"], handle);
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(moved, "result.txt"), "utf8")).toBe("approved inode");
      expect(await missing(path.join(outside, "result.txt"))).toBe(true);
    } finally { await handle.close(); }
  });

  it("fails closed on denial, invalidates changed script meaning, and executes only an approved exact command", async () => {
    const server = createServer((request, response) => {
      let body = ""; request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role?: string; content?: unknown }> };
        const lastUser = parsed.messages.map((item) => item.role).lastIndexOf("user");
        const user = JSON.stringify(parsed.messages[lastUser]?.content ?? "");
        const hasResult = parsed.messages.slice(lastUser + 1).some((item) => item.role === "tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        const push = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        const base = { id: `command-${Date.now()}`, object: "chat.completion.chunk", created: 1, model: "fake" };
        push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        if (!hasResult) {
          const file = user.includes("running-stop") ? "running-stop.txt" : user.includes("pending-stop") ? "pending-stop.txt" : user.includes("cwd-swap") ? "cwd-swap.txt" : user.includes("nested-config") ? "nested-config.txt" : user.includes("changed-config") ? "changed-config.txt" : user.includes("approved") ? "approved.txt" : "denied.txt";
          const cwd = user.includes("nested-config") || user.includes("cwd-swap") ? "packages/app" : undefined;
          const script = user.includes("running-stop")
            ? `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},'partial');setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'x'),10)`
            : `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'ran')`;
          const executable = user.includes("wrapped-env") ? "/usr/bin/env" : user.includes("wrapped-corepack") ? "corepack" : user.includes("wrapped-npx") ? "npx" : process.execPath;
          const args = user.includes("wrapped-env") ? ["npm", "install"] : user.includes("wrapped-corepack") ? ["pnpm", "add", "example"] : user.includes("wrapped-npx") ? ["example"] : ["-e", script];
          push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `command-${file}`, type: "function", function: { name: "workspace_command", arguments: JSON.stringify({ executable, args, purpose: `Create ${file}`, coveredPaths: user.includes("running-stop") ? [file] : [], ...(cwd ? { cwd } : {}) }) } }] }, finish_reason: null }] });
          push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          push({ ...base, choices: [{ index: 0, delta: { content: "Command decision recorded." }, finish_reason: null }] });
          push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        }
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No fake provider address");

    const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-command-")); temporary.push(directory);
    const project = path.join(directory, "project"); const profile = path.join(directory, "profile");
    await mkdir(project); await mkdir(profile); await mkdir(path.join(project, "packages/app"), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    await writeFile(path.join(project, "packages/app/package.json"), JSON.stringify({ scripts: { build: "node build.js" } }));
    await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { fake: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "initial", api: "openai-completions",
      models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const host = new PiAgentHost("workspace-command", project, profile, path.join(directory, "captures"));
    let latest: AgentSnapshot | undefined; let mode: "deny" | "changed-config" | "nested-config" | "cwd-swap" | "approve" | "pending-stop" = "deny";
    let pendingApproval: string | undefined; const dismissed = new Set<string>();
    const warnedExecutables = new Set<string>();
    const off = host.subscribe((event) => {
      if (event.type === "snapshot") latest = event.snapshot;
      if (event.type === "dialog-dismissed") dismissed.add(event.id);
      if (event.type === "dialog" && event.dialog.kind === "secret") host.respondToDialog({ workspaceId: "workspace-command", dialogId: event.dialog.id, value: "fake-key" });
      if (event.type === "dialog" && event.dialog.kind === "approval") {
        expect(JSON.parse(event.dialog.operation).cwdIdentity).toMatch(/^\d+:\d+$/);
        expect(event.dialog.warnings.join(" ")).toContain("execute package lifecycle scripts");
        warnedExecutables.add(JSON.parse(event.dialog.operation).executable);
        if (mode === "pending-stop") { pendingApproval = event.dialog.id; return; }
        if (mode === "cwd-swap") void (async () => {
          await rename(path.join(project, "packages/app"), path.join(project, "packages/approved-original"));
          await mkdir(path.join(project, "packages/app"));
          await writeFile(path.join(project, "packages/app/package.json"), await readFile(path.join(project, "packages/approved-original/package.json")));
          host.respondToDialog({ workspaceId: "workspace-command", dialogId: event.dialog.id, value: "approve" });
        })();
        else if (mode === "changed-config") void writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node changed.js" } })).then(() => host.respondToDialog({ workspaceId: "workspace-command", dialogId: event.dialog.id, value: "approve" }));
        else if (mode === "nested-config") void writeFile(path.join(project, "packages/app/package.json"), JSON.stringify({ scripts: { build: "node changed.js" } })).then(() => host.respondToDialog({ workspaceId: "workspace-command", dialogId: event.dialog.id, value: "approve" }));
        else host.respondToDialog({ workspaceId: "workspace-command", dialogId: event.dialog.id, ...(mode === "deny" ? { cancelled: true } : { value: "approve" }) });
      }
    });
    await host.initialize(); latest = await host.snapshot();
    await host.login({ workspaceId: "workspace-command", providerId: "fake", type: "api_key" });
    await host.selectModel({ workspaceId: "workspace-command", modelKey: "fake/fake" });

    await host.send({ workspaceId: "workspace-command", text: "denied command", behavior: "prompt", selections: [] });
    await waitFor(() => latest?.runState === "idle"); expect(await missing(path.join(project, "denied.txt"))).toBe(true);

    for (const wrapper of ["env", "corepack", "npx"]) {
      await host.send({ workspaceId: "workspace-command", text: `wrapped-${wrapper} command`, behavior: "prompt", selections: [] });
      await waitFor(() => latest?.runState === "idle");
    }
    expect([...warnedExecutables]).toEqual(expect.arrayContaining(["/usr/bin/env", "corepack", "npx"]));

    mode = "changed-config";
    await host.send({ workspaceId: "workspace-command", text: "changed-config command", behavior: "prompt", selections: [] });
    await waitFor(() => latest?.runState === "idle"); expect(await missing(path.join(project, "changed-config.txt"))).toBe(true);

    mode = "nested-config";
    await host.send({ workspaceId: "workspace-command", text: "nested-config command", behavior: "prompt", selections: [] });
    await waitFor(() => latest?.runState === "idle"); expect(await missing(path.join(project, "packages/app/nested-config.txt"))).toBe(true);

    mode = "cwd-swap";
    await host.send({ workspaceId: "workspace-command", text: "cwd-swap command", behavior: "prompt", selections: [] });
    await waitFor(() => latest?.runState === "idle");
    expect(await missing(path.join(project, "packages/app/cwd-swap.txt"))).toBe(true);
    expect(await missing(path.join(project, "packages/approved-original/cwd-swap.txt"))).toBe(true);

    mode = "approve";
    await host.send({ workspaceId: "workspace-command", text: "approved command", behavior: "prompt", selections: [] });
    await waitFor(() => latest?.runState === "idle"); expect(await readFile(path.join(project, "approved.txt"), "utf8")).toBe("ran");
    expect(host.diagnostics().changeSets[0].unexpectedPaths).toContain("approved.txt");
    mode = "pending-stop";
    await host.send({ workspaceId: "workspace-command", text: "pending-stop command", behavior: "prompt", selections: [] });
    await waitFor(() => !!pendingApproval);
    await host.stop("workspace-command");
    await waitFor(() => latest?.runState === "idle" && host.diagnostics().changeSets[0].state === "failed");
    expect(dismissed.has(pendingApproval!)).toBe(true);
    host.respondToDialog({ workspaceId: "workspace-command", dialogId: pendingApproval!, value: "approve" });
    expect(await missing(path.join(project, "pending-stop.txt"))).toBe(true);

    mode = "approve";
    await host.send({ workspaceId: "workspace-command", text: "running-stop command", behavior: "prompt", selections: [] });
    const runningFile = path.join(project, "running-stop.txt");
    const start = Date.now();
    while (await missing(runningFile)) {
      if (Date.now() - start > 5_000) throw new Error("Approved command did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await host.stop("workspace-command");
    await waitFor(() => latest?.runState === "idle" && host.diagnostics().changeSets[0].state === "failed");
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(host.diagnostics().changeSets[0].files[0].diff).toContain("partial");
    expect(host.diagnostics().changeSets[0].errors.join(" ")).toMatch(/cancelled/);
    const partial = await readFile(runningFile, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readFile(runningFile, "utf8")).toBe(partial);
    off(); await host.dispose();
  }, 15_000);
});
