import { createServer } from "node:http";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../src/application/workspace-manager";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { discoverProject } from "../../src/infrastructure/project/discovery";
import { environmentForExecutable, isPortOccupied, waitForHttp } from "../../src/infrastructure/project/dev-process";
import { resolveWorkspaceSource } from "../../src/infrastructure/project/source-resolver";
import { WorkspaceStore } from "../../src/infrastructure/project/workspace-store";

const servers: Array<ReturnType<typeof createServer>> = [];
const ServerAddress = Type.Object({ port: Type.Integer() });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mauxi-project-"));
}

describe("static project discovery", () => {
  it("approves a local start path and rejects paths that can change the preview origin", async () => {
    const root = await temporaryRoot();

    try {
      await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
      const manifest = { scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" }, mauxi: { startPath: "/login" } };
      const file = path.join(root, "package.json");
      await writeFile(file, JSON.stringify(manifest));
      const login = (await discoverProject(root)).plans[0];
      expect(login.startPath).toBe("/login");
      expect(login.diagnostics.some(item => item.code === "invalid-start-path")).toBe(false);
      await writeFile(file, JSON.stringify({ ...manifest, mauxi: { startPath: "/dashboard" } }));
      expect((await discoverProject(root)).plans[0].id).not.toBe(login.id);

      for (const startPath of ["https://example.com", "//example.com", "/\\example.com", "/\n/example.com", "/login?token=secret", "/login#token", 42]) {
        await writeFile(file, JSON.stringify({ ...manifest, mauxi: { startPath } }));
        expect((await discoverProject(root)).plans[0].diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-start-path", level: "error" }));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("finds a supported Vite plan without evaluating its config", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "sample", scripts: { dev: "vite --port 41234" }, dependencies: { react: "19.0.0", vite: "7.0.0" },
    }));
    const sentinel = path.join(root, "config-was-executed");
    await writeFile(path.join(root, "vite.config.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "bad");\nexport default { plugins: [\n] };\n`);

    const result = await discoverProject(root);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ framework: "vite", packageManager: "npm", port: 41234, dependenciesPresent: true });
    expect(result.plans[0].integration.supported).toBe(true);
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();
  });

  it("offers only Vite development scripts, not build or preview scripts", async () => {
    const root = await temporaryRoot();

    try {
      await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview --port 4173", optimize: "vite optimize", serve: "vite serve --host 127.0.0.1" },
        dependencies: { react: "19", vite: "7" },
      }));
      const result = await discoverProject(root);
      expect(result.plans.map(plan => plan.scriptName)).toEqual(["dev", "serve"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not run a repository-configured FSMonitor hook during discovery", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" } }));
    await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [\n] };\n");
    const sentinel = path.join(root, "fsmonitor-executed");
    const hook = path.join(root, "fsmonitor.sh");
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\necho\n`);
    await chmod(hook, 0o755);
    await import("node:child_process").then(({ execFile }) => new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "-q"], { cwd: root }, (error) => error ? reject(error) : resolve());
    }));
    await import("node:child_process").then(({ execFile }) => new Promise<void>((resolve, reject) => {
      execFile("git", ["config", "core.fsmonitor", hook], { cwd: root }, (error) => error ? reject(error) : resolve());
    }));
    await import("node:child_process").then(({ execFile }) => new Promise<void>((resolve, reject) => {
      execFile("git", ["status", "--porcelain"], { cwd: root }, (error) => error ? reject(error) : resolve());
    }));
    await expect(access(sentinel)).resolves.toBeUndefined();
    await rm(sentinel);
    await discoverProject(root);
    await expect(access(sentinel)).rejects.toThrow();
  });

  it("rejects workspace patterns that resolve through a symlink outside the project", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const externalApp = path.join(outside, "apps", "external");
    await mkdir(externalApp, { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["linked/*"] }));
    await writeFile(path.join(externalApp, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" } }));
    await writeFile(path.join(externalApp, "vite.config.ts"), "export default { plugins: [\n] };\n");
    await symlink(path.join(outside, "apps"), path.join(root, "linked"), "dir");
    const result = await discoverProject(root);
    expect(result.plans).toHaveLength(0);
    expect(result.plans.every((plan) => plan.appRoot.startsWith(`${root}${path.sep}`))).toBe(true);
  });

  it("surfaces ambiguous workspace app roots instead of guessing", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["apps/*"] }));

    for (const name of ["one", "two"]) {
      const app = path.join(root, "apps", name);
      await mkdir(path.join(app, "node_modules", ".bin"), { recursive: true });
      await writeFile(path.join(app, "node_modules", ".bin", "vite"), "");
      await writeFile(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" } }));
      await writeFile(path.join(app, "vite.config.ts"), "export default { plugins: [\n] };\n");
    }

    const result = await discoverProject(root);
    expect(result.plans).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous-plan" }));
  });
});

describe("ownership and source boundaries", () => {
  it("waits through an old Vite response and restart until the preview script is served", async () => {
    let requests = 0;

    const server = createServer((request, response) => {
      requests++;

      if (requests === 1) response.end("<html>old configuration</html>");
      else if (requests === 2) request.socket.destroy();
      else response.end('<html><script src="/.mauxi/bridge.js"></script></html>');
    });

    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    if (!Value.Check(ServerAddress, address)) throw new Error("Missing test port");
    await waitForHttp(`http://127.0.0.1:${address.port}`, 4_000, () => false, ".mauxi/bridge.js");
    expect(requests).toBe(3);
  });
  it("prepends a discovered package manager directory to the child PATH", () => {
    const executable = path.join("/home/tester/.nvm/versions/node/v22/bin", "npm");
    const environment = environmentForExecutable(executable, { PATH: "/usr/bin" });
    expect(environment.PATH?.split(path.delimiter)).toEqual([path.dirname(executable), "/usr/bin"]);
  });
  it("attaches explicitly and leaves the unrelated process running on close", async () => {
    let serverHtml = "unrelated";
    const server = createServer((_request, response) => response.end(serverHtml));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    if (!Value.Check(ServerAddress, address)) throw new Error("Missing test port");
    expect(await isPortOccupied(address.port)).toBe(true);

    const root = await temporaryRoot();
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
    const manifest = JSON.stringify({ scripts: { dev: `vite --port ${address.port}` }, dependencies: { react: "19", vite: "7" }, mauxi: { startPath: "/login" } });
    await writeFile(path.join(root, "package.json"), manifest);
    await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [\n] };\n");
    const bridge = path.join(root, "bridge-entry.js");
    await writeFile(bridge, "globalThis.__mauxiBridge = true;\n");

    const manager = new WorkspaceManager(
      new JournalStore(path.join(root, "state", "recovery")),
      new WorkspaceStore(path.join(root, "state", "workspaces")),
      bridge,
    );

    const staleDiscovery = await manager.inspect(root);
    await writeFile(path.join(root, "package.json"), manifest.replace("vite --port", "vite --host 127.0.0.1 --port"));
    await expect(manager.confirm({ discoveryId: staleDiscovery.discoveryId, planId: staleDiscovery.plans[0].id, mode: "start" })).rejects.toThrow("changed");
    await writeFile(path.join(root, "package.json"), manifest);

    const discovery = await manager.inspect(root);
    expect(await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text())).toBe("unrelated");
    serverHtml = '<script src="/.mauxi/bridge.js"></script>';
    const active = await manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "attach" });
    expect(active.ownership).toBe("attached");
    expect(active.startPath).toBe("/login");
    await manager.close();
    serverHtml = "unrelated";

    const body = await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text());
    expect(body).toBe("unrelated");
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).not.toContain("mauxi-owned:start");
  });

  it("rejects escaping source hints and resolves one in-workspace file", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "App.tsx"), "export const App = () => <svg data-testid=\"known-icon\"><path d=\"M0 0\" /></svg>;\n");
    await writeFile(path.join(outside, "App.tsx"), "forged\n");
    expect(await resolveWorkspaceSource(root, path.join(outside, "App.tsx"))).toBeNull();
    expect(await resolveWorkspaceSource(root, "src/App.tsx", 1, 10)).toMatchObject({ filePath: "src/App.tsx" });
    expect(await resolveWorkspaceSource(root, "/src/App.tsx", 1, 10)).toMatchObject({ filePath: "src/App.tsx" });
    expect(await resolveWorkspaceSource(root, "webpack-internal:///./src/App.tsx", 1, 10)).toMatchObject({ filePath: "src/App.tsx" });
    expect(await resolveWorkspaceSource(root, "src/App.tsx", 69, 118, { tag: "path", testIds: ["known-icon"] })).toMatchObject({ filePath: "src/App.tsx", lineNumber: 1, method: "jsx-attribute" });
    expect(await resolveWorkspaceSource(root, "src/App.tsx", 1, 1, { tag: "path", testIds: [] })).toMatchObject({ filePath: "src/App.tsx", lineNumber: 1, columnNumber: 56, method: "jsx-attribute" });
    expect(await resolveWorkspaceSource(root, "src/App.tsx", 50, 1)).toBeNull();
    await writeFile(path.join(root, "src", "Tags.tsx"), "export const Tags = () => <><div /><div /></>;\n");
    expect(await resolveWorkspaceSource(root, "src/Tags.tsx", 1, 29, { tag: "div", testIds: [] })).toBeNull();
    await mkdir(path.join(root, "other"));
    await writeFile(path.join(root, "other", "App.tsx"), "export const Other = () => null;\n");
    expect(await resolveWorkspaceSource(root, "App.tsx")).toBeNull();
  });
});

it("keeps failed setup visible when an owned file is missing but its journal exists", async () => {
  const root = await temporaryRoot();
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules/.bin/vite"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" } }));
  await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
  const bridge = path.join(root, "bridge-entry.js"); await writeFile(bridge, "// bridge");

  class MissingOwnerStore extends JournalStore {
    override async write(journal: Parameters<JournalStore["write"]>[0]) {
      await super.write(journal);

      if (journal.state === "applied" && journal.runtime) await rm(path.join(journal.runtime.path, "owner"));
    }
  }

  const store = new MissingOwnerStore(path.join(root, "state"));
  const manager = new WorkspaceManager(store, new WorkspaceStore(path.join(root, "settings")), bridge);

  try {
    const discovery = await manager.inspect(root);
    await expect(manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" })).rejects.toThrow();
    expect(manager.snapshot().active?.status).toBe("failed");
    expect(manager.snapshot().recoveryConflicts.join("\n")).toContain("Setup cleanup failed");
    const journal = (await store.list())[0];
    expect(journal.state).not.toBe("clean");
    await writeFile(path.join(journal.runtime!.path, "owner"), journal.runtime!.token);
    await manager.close();
  } finally { await manager.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

it("waits for an in-flight setup before closing instead of cleaning up concurrently", async () => {
  const server = createServer((_request, response) => response.end('<script src="/.mauxi/bridge.js"></script>'));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!Value.Check(ServerAddress, address)) throw new Error("Missing test port");
  const root = await temporaryRoot();
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: `vite --port ${address.port}` }, dependencies: { react: "19", vite: "7" } }));
  await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [\n] };\n");
  const bridge = path.join(root, "bridge-entry.js"); await writeFile(bridge, "// bridge\n");
  const writes: string[] = [];
  let reachedApplying!: () => void; const applying = new Promise<void>((resolve) => { reachedApplying = resolve; });
  let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });

  class GatedStore extends JournalStore {
    override async write(journal: Parameters<JournalStore["write"]>[0]) {
      if (journal.state === "applying" && !writes.includes("applying")) { reachedApplying(); await released; }

      writes.push(journal.state);
      await super.write(journal);
    }
  }

  const store = new GatedStore(path.join(root, "state"));
  const manager = new WorkspaceManager(store, new WorkspaceStore(path.join(root, "settings")), bridge);

  try {
    const discovery = await manager.inspect(root);
    const setup = manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "attach" });
    const setupResult = setup.then(() => "ready", () => "failed");
    await applying;
    let closed = false;

    const closing = manager.close().then((event) => { closed = true;

    return event; });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    expect(writes).not.toContain("cleaning");
    release();
    expect((await closing).active).toBeNull();
    expect(await setupResult).toBe("failed");
    expect(writes.indexOf("cleaning")).toBeGreaterThan(writes.lastIndexOf("applied"));
    expect(writes.at(-1)).toBe("clean");
    expect((await store.list())[0].state).toBe("clean");
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).not.toContain("mauxi-owned:start");
    await expect(access(path.join(root, ".mauxi", "bridge.js"))).rejects.toThrow();
  } finally { await manager.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

it("shares one cleanup when the project is closed and the app quits at the same time", async () => {
  const server = createServer((_request, response) => response.end('<script src="/.mauxi/bridge.js"></script>'));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!Value.Check(ServerAddress, address)) throw new Error("Missing test port");
  const root = await temporaryRoot();
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: `vite --port ${address.port}` }, dependencies: { react: "19", vite: "7" } }));
  await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [\n] };\n");
  const bridge = path.join(root, "bridge-entry.js"); await writeFile(bridge, "// bridge\n");
  const writes: string[] = [];

  class RecordingStore extends JournalStore {
    override async write(journal: Parameters<JournalStore["write"]>[0]) { writes.push(journal.state); await super.write(journal); }
  }

  const store = new RecordingStore(path.join(root, "state"));
  const manager = new WorkspaceManager(store, new WorkspaceStore(path.join(root, "settings")), bridge);

  try {
    const discovery = await manager.inspect(root);
    await manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "attach" });
    const [first, second] = await Promise.all([manager.close(), manager.close()]);
    expect(first.active).toBeNull(); expect(second.active).toBeNull();
    expect(writes.filter((state) => state === "clean")).toHaveLength(1);
    expect((await store.list())[0].state).toBe("clean");
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).not.toContain("mauxi-owned:start");
  } finally { await manager.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
