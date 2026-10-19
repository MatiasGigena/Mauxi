import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { WorkspaceManager } from "../../src/application/workspace-manager";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { availablePort, waitForHttp } from "../../src/infrastructure/project/dev-process";
import { WorkspaceStore } from "../../src/infrastructure/project/workspace-store";

// Lifecycle failure modes: overlapping confirmation writes conflicting hooks or leaks a server;
// rejected confirmation clears the successful active workspace; close misses work not yet reserved.
it("accepts exactly one overlapping confirmation and cleans the successful server", async () => {
  const evidence = path.resolve("test-results/bug-hunt/lifecycle");
  await mkdir(evidence, { recursive: true });
  const base = await mkdtemp(path.join(evidence, "confirm-"));
  const root = path.join(base, "project");
  const journals = new JournalStore(path.join(base, "journals"));
  const manager = new WorkspaceManager(journals, new WorkspaceStore(path.join(base, "settings")), path.join(base, "bridge.js"));
  const states: unknown[] = [];
  manager.subscribe(state => states.push(state));
  let results: unknown;

  try {
    await mkdir(root);
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const port = await availablePort();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { dev: `vite --port ${port}` }, dependencies: { react: "19", vite: "7" } }));
    await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
    await writeFile(path.join(root, "index.html"), "<h1>concurrent confirmation</h1>");
    await writeFile(path.join(base, "bridge.js"), "// lifecycle bridge\n");
    const discovery = await manager.inspect(root);
    const request = { discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" as const };
    const settled = await Promise.allSettled([manager.confirm(request), manager.confirm(request)]);
    results = settled.map(result => result.status === "fulfilled" ? result : { status: result.status, reason: String(result.reason) });
    const successes = settled.filter(result => result.status === "fulfilled");
    expect(successes, JSON.stringify(results)).toHaveLength(1);
    const active = manager.snapshot().active;
    expect(active).not.toBeNull();
    expect(await fetch(active!.origin).then(response => response.text())).toContain("concurrent confirmation");
    await manager.close();
    expect(manager.snapshot().active).toBeNull();
    expect(await readFile(path.join(root, "vite.config.ts"), "utf8")).toBe("export default { plugins: [] };\n");
    expect((await journals.list()).every(journal => journal.state === "clean")).toBe(true);
    await expect(fetch(active!.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    await manager.close().catch(() => undefined);
    await manager.initialize();
    await writeFile(path.join(evidence, "concurrent-confirmation.json"), JSON.stringify({ results, states, journals: await journals.list() }, null, 2));
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

it("closes a project when close arrives during confirmation validation", async () => {
  const evidence = path.resolve("test-results/bug-hunt/lifecycle");
  await mkdir(evidence, { recursive: true });
  const base = await mkdtemp(path.join(evidence, "early-close-"));
  const root = path.join(base, "project");
  const journals = new JournalStore(path.join(base, "journals"));
  const manager = new WorkspaceManager(journals, new WorkspaceStore(path.join(base, "settings")), path.join(base, "bridge.js"));
  let observed = manager.snapshot();

  try {
    await mkdir(root);
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const port = await availablePort();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { dev: `vite --port ${port}` }, dependencies: { react: "19", vite: "7" } }));
    await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
    await writeFile(path.join(root, "index.html"), "<h1>early close</h1>");
    await writeFile(path.join(base, "bridge.js"), "// lifecycle bridge\n");
    const discovery = await manager.inspect(root);
    const confirmation = manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start" });
    const closing = manager.close();
    const [confirmed] = await Promise.all([confirmation, closing]);
    observed = manager.snapshot();
    expect(manager.snapshot().active).toBeNull();
    expect((await journals.list()).every(journal => journal.state === "clean")).toBe(true);
    await expect(fetch(confirmed.origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    await manager.close().catch(() => undefined);
    await manager.initialize();
    await writeFile(path.join(evidence, "early-close.json"), JSON.stringify({ state: observed, journals: await journals.list() }, null, 2));
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

// Readiness failure modes: a legitimate local route redirects to its trailing slash;
// an external redirect must not prove local readiness; loops must respect the deadline.
it("starts a Vite project whose initial route redirects to a local directory index", async () => {
  const evidence = path.resolve("test-results/bug-hunt/lifecycle");
  await mkdir(evidence, { recursive: true });
  const base = await mkdtemp(path.join(evidence, "redirect-"));
  const root = path.join(base, "project");
  const journals = new JournalStore(path.join(base, "journals"));
  const manager = new WorkspaceManager(journals, new WorkspaceStore(path.join(base, "settings")), path.join(base, "bridge-entry.js"));
  let observed = { state: manager.snapshot(), finalUrl: "", html: "" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let confirmation: ReturnType<typeof manager.confirm> | undefined;

  try {
    await mkdir(path.join(root, "login"), { recursive: true });
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const port = await availablePort();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { dev: `vite --port ${port}` }, dependencies: { react: "19", vite: "7" } }));
    await writeFile(path.join(root, "vite.config.ts"), `export default { plugins: [{ name: "login-redirect", configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== "/login") return next(); response.statusCode = 302; response.setHeader("Location", "/login/"); response.end(); }); } }] };\n`);
    await writeFile(path.join(root, "index.html"), "<h1>home</h1>");
    await writeFile(path.join(root, "login/index.html"), "<h1>directory login</h1>");
    await writeFile(path.join(base, "bridge-entry.js"), "// lifecycle bridge\n");
    const discovery = await manager.inspect(root);
    confirmation = manager.confirm({ discoveryId: discovery.discoveryId, planId: discovery.plans[0].id, mode: "start", startPath: "/login" });
    const active = await Promise.race([confirmation, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Local redirect did not become ready within five seconds")), 5_000); })]);
    const response = await fetch(`${active.origin}/login`);
    const html = await response.text();
    observed = { state: manager.snapshot(), finalUrl: response.url, html };
    expect(response.url).toBe(`${active.origin}/login/`);
    expect(html).toContain("directory login");
    expect(active.status).toBe("connecting-previews");
  } finally {
    clearTimeout(timeout);
    await manager.close().catch(() => undefined);
    await confirmation?.catch(() => undefined);
    await manager.initialize();
    await writeFile(path.join(evidence, "redirect-readiness.json"), JSON.stringify(observed, null, 2));
    await rm(base, { recursive: true, force: true });
  }
}, 15_000);

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = Value.Parse(Type.Object({ port: Type.Integer() }), server.address());

  return `http://127.0.0.1:${address.port}`;
}

it.each(["external", "credentials", "loop"])("refuses %s redirects while proving preview readiness", async kind => {
  const evidence = path.resolve("test-results/bug-hunt/lifecycle");
  await mkdir(evidence, { recursive: true });
  const requests: string[] = [];
  let externalRequests = 0;
  const external = createServer((_request, response) => { externalRequests++; response.end(".mauxi/bridge.js"); });
  const externalOrigin = await listen(external);
  let origin = "";

  const server = createServer((request, response) => {
    requests.push(request.url ?? "");

    if (request.url === "/target") { response.end(".mauxi/bridge.js");

 return; }

    const location = kind === "external" ? externalOrigin : kind === "credentials" ? origin.replace("http://", "http://test:test@") + "/target" : request.url === "/a" ? "/b" : "/a";
    response.writeHead(302, { Location: location }); response.end();
  });

  origin = await listen(server);
  const started = Date.now();

  try {
    await expect(waitForHttp(origin, 350, () => false, ".mauxi/bridge.js")).rejects.toThrow("Timed out waiting");
    expect(externalRequests).toBe(0);
    expect(requests).not.toContain("/target");
    expect(requests.length).toBeLessThanOrEqual(11);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => external.close(() => resolve()))]);
    await writeFile(path.join(evidence, `redirect-${kind}.json`), JSON.stringify({ requests, externalRequests, elapsedMs: Date.now() - started }, null, 2));
  }
});
