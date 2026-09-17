import { createServer } from "node:http";
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../../src/application/workspace-manager";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { discoverProject } from "../../src/infrastructure/project/discovery";
import { environmentForExecutable, isPortOccupied } from "../../src/infrastructure/project/dev-process";
import { resolveWorkspaceSource } from "../../src/infrastructure/project/source-resolver";
import { WorkspaceStore } from "../../src/infrastructure/project/workspace-store";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mauxi-project-"));
}

describe("static project discovery", () => {
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
  it("prepends a discovered package manager directory to the child PATH", () => {
    const executable = path.join("/home/tester/.nvm/versions/node/v22/bin", "npm");
    const environment = environmentForExecutable(executable, { PATH: "/usr/bin" });
    expect(environment.PATH?.split(path.delimiter)).toEqual([path.dirname(executable), "/usr/bin"]);
  });
  it("attaches explicitly and leaves the unrelated process running on close", async () => {
    const server = createServer((_request, response) => response.end("unrelated"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    expect(await isPortOccupied(address.port)).toBe(true);

    const root = await temporaryRoot();
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules", ".bin", "vite"), "");
    const manifest = JSON.stringify({ scripts: { dev: `vite --port ${address.port}` }, dependencies: { react: "19", vite: "7" } });
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
    await expect(manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" })).rejects.toThrow("already occupied");
    expect(await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text())).toBe("unrelated");
    const active = await manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "attach" });
    expect(active.ownership).toBe("attached");
    await manager.close();

    const body = await fetch(`http://127.0.0.1:${address.port}`).then((response) => response.text());
    expect(body).toBe("unrelated");
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).not.toContain("mauxi-owned:start");
  });

  it("rejects escaping source hints and resolves one in-workspace file", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "App.tsx"), "export const App = () => null;\n");
    await writeFile(path.join(outside, "App.tsx"), "forged\n");
    expect(await resolveWorkspaceSource(root, path.join(outside, "App.tsx"))).toBeNull();
    expect(await resolveWorkspaceSource(root, "src/App.tsx")).toMatchObject({ filePath: "src/App.tsx" });
  });
});
