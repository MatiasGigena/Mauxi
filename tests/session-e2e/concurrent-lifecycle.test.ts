import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkspaceManager } from "../../src/application/workspace-manager";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { availablePort } from "../../src/infrastructure/project/dev-process";
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
