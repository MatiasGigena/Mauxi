import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkspaceManager } from "../../src/application/workspace-manager";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { WorkspaceStore } from "../../src/infrastructure/project/workspace-store";

it.each(["vite", "next-webpack", "next-turbopack"])("imports %s with an occupied port and cleans its session while preserving edits", async kind => {
  await mkdir(path.resolve("test-results"), { recursive: true });
  const base = await mkdtemp(path.resolve("test-results/mauxi-import-"));
  const root = path.join(base, "project");
  const blocker = createServer((_request, response) => response.end("other project"));
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("No port");
  let lastState: unknown;
  const framework = kind === "vite" ? "vite" : "next";
  const manager = new WorkspaceManager(new JournalStore(path.join(base, "journals")), new WorkspaceStore(path.join(base, "settings")), path.join(base, "bridge-entry.js"));
  manager.subscribe(state => { if (state.active) lastState = state; });
  try {
    await mkdir(root);
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const script = framework === "vite" ? `vite --port ${address.port}` : `next dev --${kind === "next-webpack" ? "webpack" : "turbopack"} --port ${address.port}`;
    const manifest = JSON.stringify({ name: "disposable", private: true, type: "module", scripts: { dev: script }, dependencies: { react: "19.3.0", "react-dom": "19.3.0", [framework]: framework === "next" ? "16.3.5" : "7.3.6" } }, null, 2);
    await writeFile(path.join(root, "package.json"), manifest);
    await writeFile(path.join(base, "bridge-entry.js"), "window.__sessionBridge = true;\n");
    const configFile = path.join(root, framework === "vite" ? "vite.config.ts" : kind === "next-turbopack" ? "next.config.ts" : "next.config.mjs");
    let config = framework === "vite" ? 'export default { plugins: [], server: { port: 5180 } };\n' : `export default { poweredByHeader: false, turbopack: { root: ${JSON.stringify(path.resolve('.'))} } };\n`;
    if (kind === "next-turbopack") config = `import type { NextConfig } from "next";\nconst config = { poweredByHeader: false, turbopack: { root: ${JSON.stringify(path.resolve('.'))} } } satisfies NextConfig;\nexport default config;\n`;
    await writeFile(configFile, config);
    let sourceFile: string;
    if (framework === "vite") {
      sourceFile = path.join(root, "index.html");
      await writeFile(sourceFile, '<h1>before</h1>');
    } else {
      await mkdir(path.join(root, "app/login"), { recursive: true });
      await writeFile(path.join(root, "app/layout.tsx"), 'export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }');
      sourceFile = path.join(root, "app/login/page.tsx");
      await writeFile(sourceFile, 'export default function Page() { return <h1>before</h1>; }');
      await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"jsx":"preserve","strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true},"include":["app/**/*.tsx"]}\n');
      await writeFile(path.join(root, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
      await mkdir(path.join(root, ".next"));
      await writeFile(path.join(root, ".next/existing-cache"), "preserve unrelated cache");
    }
    const tsBefore = framework === "next" ? await readFile(path.join(root, "tsconfig.json"), "utf8") : null;
    const typesBefore = framework === "next" ? await readFile(path.join(root, "next-env.d.ts"), "utf8") : null;
    const discovery = await manager.inspect(root);
    const active = await manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start", startPath: "/login" });
    expect(new URL(active.origin).port).not.toBe(String(address.port));
    expect(await fetch(`http://127.0.0.1:${address.port}`).then(r => r.text())).toBe("other project");
    expect(await fetch(`${active.origin}/login`).then(r => r.text())).toContain("before");
    await writeFile(sourceFile, (await readFile(sourceFile, "utf8")).replace("before", "after"));
    // A new user edit in the same configuration must survive session removal.
    await writeFile(configFile, (await readFile(configFile, "utf8")) + "// keep this edit\n");
    await manager.close();
    expect(await readFile(configFile, "utf8")).toBe(config + "// keep this edit\n");
    expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(manifest);
    expect(await readFile(sourceFile, "utf8")).toContain("after");
    await expect(access(path.join(root, ".mauxi"))).rejects.toMatchObject({ code: "ENOENT" });
    if (framework === "next") {
      expect(await readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(tsBefore);
      expect(await readFile(path.join(root, "next-env.d.ts"), "utf8")).toBe(typesBefore);
      expect(await readdir(path.join(root, ".next"))).toEqual(["existing-cache"]);
      await expect(access(path.join(root, "instrumentation-client.js"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const reopened = await manager.inspect(root);
    expect(reopened.plans[0].startPath).toBe("/login");
  } catch (error) {
    console.error(lastState);
    throw error;
  } finally {
    await manager.close().catch(error => console.error("Cleanup:", error));
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
}, 120_000);

it("recovers a killed owner before removing its session and preserves subsequent edits", async () => {
  const base = await mkdtemp(path.resolve("test-results/mauxi-crash-"));
  const root = path.join(base, "project");
  await mkdir(root);
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { dev: "vite" }, dependencies: { react: "19", vite: "7" } }));
  const config = 'export default { plugins: [] };\n';
  await writeFile(path.join(root, "vite.config.ts"), config);
  await writeFile(path.join(root, "index.html"), "<h1>recover</h1>");
  const bridge = path.join(base, "bridge-entry.js"); await writeFile(bridge, "// bridge");
  const controller = path.join(base, "owner.mjs");
  await writeFile(controller, `
    import { WorkspaceManager } from ${JSON.stringify(path.resolve("src/application/workspace-manager.ts"))};
    import { JournalStore } from ${JSON.stringify(path.resolve("src/infrastructure/instrumentation/journal.ts"))};
    import { WorkspaceStore } from ${JSON.stringify(path.resolve("src/infrastructure/project/workspace-store.ts"))};
    const manager = new WorkspaceManager(new JournalStore(${JSON.stringify(path.join(base, "journals"))}), new WorkspaceStore(${JSON.stringify(path.join(base, "settings"))}), ${JSON.stringify(bridge)});
    const discovery = await manager.inspect(${JSON.stringify(root)});
    const active = await manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" });
    process.send(active.origin);
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, ["--import", "tsx", controller], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
  const recovered = new WorkspaceManager(new JournalStore(path.join(base, "journals")), new WorkspaceStore(path.join(base, "settings")), bridge);
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output || "Owner startup timed out")), 60_000);
      child.once("message", value => { clearTimeout(timer); resolve(String(value)); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(output || "Owner exited")); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    await writeFile(path.join(root, "vite.config.ts"), (await readFile(path.join(root, "vite.config.ts"), "utf8")) + "// saved user edit\n");
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
    expect(await fetch(origin).then(response => response.status)).toBe(200);
    await recovered.initialize();
    expect(recovered.snapshot().recoveryConflicts).toEqual([]);
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toBe(config + "// saved user edit\n");
    await expect(access(path.join(root, ".mauxi"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await recovered.initialize();
    await rm(base, { recursive: true, force: true });
  }
}, 120_000);
