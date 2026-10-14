import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("patches the Vite config file that Vite itself loads", async () => {
    const { root } = await setup();
    await writeFile(path.join(root, "vite.config.js"), "export default { plugins: [] };\n");
    expect((await prepareIntegrationPlan(root, "vite")).configPath).toBe(path.join(root, "vite.config.js"));
    await writeFile(path.join(root, "vite.config.cjs"), "module.exports = { plugins: [] };\n");
    await rm(path.join(root, "vite.config.js"));
    await expect(prepareIntegrationPlan(root, "vite")).resolves.toMatchObject({ configPath: path.join(root, "vite.config.ts") });
    await rm(path.join(root, "vite.config.ts"));
    await expect(prepareIntegrationPlan(root, "vite")).rejects.toThrow("vite.config.cjs");
  });

  it("cleans a setup that failed before its config patch was written", async () => {
    const { plan, store, bridgeEntry } = await setup();
    const userEdit = "// saved by the user during setup\n";

    class EditingStore extends JournalStore {
      override async write(journal: Parameters<JournalStore["write"]>[0]) {
        await super.write(journal);

        if (journal.state === "applying" && await readFile(plan.bridgePath).then(() => true, () => false)) {
          const current = await readFile(plan.configPath, "utf8");

          if (!current.includes(userEdit)) await writeFile(plan.configPath, current + userEdit);
        }
      }
    }

    const editing = new EditingStore(store.directory);
    await expect(applyIntegration(plan, editing, bridgeEntry)).rejects.toThrow("File changed while setup was being prepared");
    const cleaned = await cleanupIntegration(transactionIdFor(plan), new JournalStore(store.directory));
    expect(cleaned.conflicts).toEqual([]);
    expect(cleaned.state).toBe("clean");
    expect(await readFile(plan.configPath, "utf8")).toBe(config + userEdit);
    await expect(readFile(plan.bridgePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a setup that failed before writing its owned artifacts", async () => {
    const { root, plan, store, bridgeEntry } = await setup();
    const blocker = path.join(root, ".mauxi");

    class BlockingStore extends JournalStore {
      override async write(journal: Parameters<JournalStore["write"]>[0]) {
        await super.write(journal);

        if (journal.state === "applying") await writeFile(blocker, "user file\n", { flag: "a" });
      }
    }

    await expect(applyIntegration(plan, new BlockingStore(store.directory), bridgeEntry)).rejects.toThrow();
    const cleaned = await cleanupIntegration(transactionIdFor(plan), new JournalStore(store.directory));
    expect(cleaned.conflicts).toEqual([]);
    expect(cleaned.state).toBe("clean");
    expect(await readFile(plan.configPath, "utf8")).toBe(config);
    expect(await readFile(blocker, "utf8")).toBe("user file\n");
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
});
