import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, createIntegrationPlan, prepareIntegrationPlan, transactionIdFor } from "../../src/infrastructure/instrumentation/plan";

const execFileAsync = promisify(execFile);

const config = `import { defineConfig } from "vite";\nexport default defineConfig(({ command }) => ({\n  plugins: [\n    // Mauxi development integration is inserted here.\n  ],\n}));\n`;

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-instrumentation-"));
  const root = path.join(directory, "project");
  const journalDirectory = path.join(directory, "journals");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
  await writeFile(path.join(root, "vite.config.ts"), config);
  const bridgeEntry = path.join(directory, "bridge.ts");
  await writeFile(bridgeEntry, "globalThis.__proofBridge = true;\n");
  const plan = createIntegrationPlan(root, "vite");
  const store = new JournalStore(journalDirectory);
  return { root, plan, store, bridgeEntry };
}

async function setupNext(configContent: string, fileName = "next.config.mjs") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-next-instrumentation-"));
  const root = path.join(directory, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
  await writeFile(path.join(root, fileName), configContent);
  const bridgeEntry = path.join(directory, "bridge-entry.js");
  await writeFile(bridgeEntry, "globalThis.__proofBridge = true;\n");
  const store = new JournalStore(path.join(directory, "journals"));
  return { root, store, bridgeEntry, configPath: path.join(root, fileName) };
}

describe("owned instrumentation", () => {
  it.each([
    ["inline Tailwind then React", "[tailwindcss(), react()]", ["tailwind", "react"]],
    ["inline React then Tailwind", "[react(), tailwindcss()]", ["react", "tailwind"]],
    ["empty inline", "[]", []],
    ["multiline with comments", "[\r\n  // keep plugin order\r\n  react(),\r\n  tailwindcss(),\r\n]", ["react", "tailwind"]],
  ])("instruments a %s array and restores the exact config", async (_label, array, names) => {
    const { root, store, bridgeEntry } = await setup();
    const configPath = path.join(root, "vite.config.ts");
    const original = `const react = () => ({ name: "react" });\nconst tailwindcss = () => ({ name: "tailwind" });\nconst defineConfig = value => value;\n// Example: plugins: [notActualConfig()]\nconst note = "plugins: [decoy()] $& $' $\u0060 $$";\nexport default defineConfig({ note, plugins: ${array} });\n`;
    await writeFile(configPath, original);
    const plan = await prepareIntegrationPlan(root, "vite");
    expect(await readFile(configPath, "utf8")).toBe(original);
    const applied = await applyIntegration(plan, store, bridgeEntry);
    const patched = await readFile(configPath, "utf8");
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e",
      `const { default: config } = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(patched)}`)}); console.log(JSON.stringify({ names: config.plugins.map(p => p.name), apply: config.plugins[0].apply, note: config.note }));`,
    ]);
    expect(JSON.parse(stdout)).toEqual({ names: ["mauxi-preview-bridge", ...names], apply: "serve", note: "plugins: [decoy()] $& $' $` $$" });
    const userEdit = "\n// concurrent user edit\n";
    await writeFile(configPath, patched + userEdit);
    expect((await cleanupIntegration(applied.transactionId, store)).state).toBe("clean");
    expect(await readFile(configPath, "utf8")).toBe(original + userEdit);
    await expect(readFile(plan.bridgePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    'const example = "plugins: [react()]"; export default {};',
    '// plugins: [react()]\nexport default {};',
    'export default { plugins: [], nested: { plugins: [] } };',
  ])("refuses missing or ambiguous plugin arrays without modifying config: %s", async original => {
    const { root } = await setup();
    const configPath = path.join(root, "vite.config.ts");
    await writeFile(configPath, original);
    await expect(prepareIntegrationPlan(root, "vite")).rejects.toThrow("missing or ambiguous");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("records before mutation and removes only its region", async () => {
    const { root, plan, store, bridgeEntry } = await setup();
    const applied = await applyIntegration(plan, store, bridgeEntry);
    expect(applied.state).toBe("applied");
    const journalOnDisk = JSON.parse(await readFile(store.pathFor(applied.transactionId), "utf8"));
    expect(journalOnDisk.state).toBe("applied");

    const configPath = path.join(root, "vite.config.ts");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n// unrelated user edit\n`);
    // Model a kill after the config write but before its final journal flag was persisted.
    applied.state = "applying";
    applied.patches[0].applied = false;
    await store.write(applied);
    // A fresh store instance models next-launch recovery after the owner process died.
    const recoveredStore = new JournalStore(store.directory);
    const cleaned = await cleanupIntegration(transactionIdFor(plan), recoveredStore);
    const finalConfig = await readFile(configPath, "utf8");
    expect(cleaned.state).toBe("clean");
    expect(finalConfig).not.toContain("mauxi-owned:start");
    expect(finalConfig).toContain("unrelated user edit");
  });

  it("preserves a changed owned artifact and reports a conflict", async () => {
    const { plan, store, bridgeEntry } = await setup();
    const applied = await applyIntegration(plan, store, bridgeEntry);
    const ownedBridge = await readFile(plan.bridgePath);
    await writeFile(plan.bridgePath, "user changed this artifact\n");
    const cleaned = await cleanupIntegration(applied.transactionId, store);
    expect(cleaned.state).toBe("conflicted");
    expect(await readFile(plan.bridgePath, "utf8")).toContain("user changed");
    await writeFile(plan.bridgePath, ownedBridge);
    const retried = await cleanupIntegration(applied.transactionId, store);
    expect(retried.state).toBe("clean");
    expect(retried.conflicts).toEqual([]);
  });

  it("does not overwrite a concurrent edit inside its owned region", async () => {
    const { plan, store, bridgeEntry } = await setup();
    const applied = await applyIntegration(plan, store, bridgeEntry);
    const current = await readFile(plan.configPath, "utf8");
    await writeFile(plan.configPath, `${current.replace("mauxi-preview-bridge", "user-modified-preview-bridge")}\n// user work\n`);
    const cleaned = await cleanupIntegration(applied.transactionId, store);
    expect(cleaned.state).toBe("conflicted");
    expect(await readFile(plan.configPath, "utf8")).toContain("user-modified-preview-bridge");
    expect(await readFile(plan.configPath, "utf8")).toContain("user work");
  });

  it.each([
    ["named ESM config", "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n", "next.config.mjs"],
    ["existing webpack hook", "export default { webpack(config) { return config; } };\n", "next.config.mjs"],
    ["CommonJS object", "module.exports = { reactStrictMode: true };\n", "next.config.js"],
    ["function-generated config", "export default async function config() { return { reactStrictMode: true }; }\n", "next.config.mjs"],
    ["typed config", "import type { NextConfig } from 'next';\nconst config = { reactStrictMode: true } satisfies NextConfig;\nexport default config;\n", "next.config.ts"],
  ])("supports a %s without parsing or rewriting it", async (_label, configContent, fileName) => {
    const { root, store, bridgeEntry, configPath } = await setupNext(configContent, fileName);
    const plan = await prepareIntegrationPlan(root, "next");
    const applied = await applyIntegration(plan, store, bridgeEntry);
    expect(await readFile(configPath, "utf8")).toBe(configContent);
    expect(await readFile(plan.configPath, "utf8")).toContain("mauxi-owned:start preview-bridge");
    const cleaned = await cleanupIntegration(applied.transactionId, store);
    expect(cleaned.state).toBe("clean");
    await expect(readFile(plan.configPath, "utf8")).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(configContent);
  });

  it("patches an existing instrumentation client and preserves concurrent user work", async () => {
    const { root, store, bridgeEntry } = await setupNext("export default {};\n");
    const clientPath = path.join(root, "instrumentation-client.ts");
    await writeFile(clientPath, "console.info('user instrumentation');\n");
    const plan = await prepareIntegrationPlan(root, "next");
    const applied = await applyIntegration(plan, store, bridgeEntry);
    await writeFile(clientPath, `${await readFile(clientPath, "utf8")}\n// concurrent user work\n`);
    const cleaned = await cleanupIntegration(applied.transactionId, store);
    expect(cleaned.state).toBe("clean");
    const final = await readFile(clientPath, "utf8");
    expect(final).toContain("user instrumentation");
    expect(final).toContain("concurrent user work");
    expect(final).not.toContain("mauxi-owned:start");
  });

  it("leaves the Git index and untracked work unchanged", async () => {
    const { root, plan, store, bridgeEntry } = await setup();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["add", "vite.config.ts"], { cwd: root });
    await writeFile(path.join(root, "untracked.txt"), "keep me\n");
    const beforeIndex = await execFileAsync("git", ["diff", "--cached", "--binary"], { cwd: root });
    const applied = await applyIntegration(plan, store, bridgeEntry);
    await cleanupIntegration(applied.transactionId, store);
    const afterIndex = await execFileAsync("git", ["diff", "--cached", "--binary"], { cwd: root });
    expect(afterIndex.stdout).toBe(beforeIndex.stdout);
    expect(await readFile(path.join(root, "untracked.txt"), "utf8")).toBe("keep me\n");
  });
});
