import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, createIntegrationPlan, transactionIdFor } from "../../src/infrastructure/instrumentation/plan";

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
    await writeFile(plan.bridgePath, "user changed this artifact\n");
    const cleaned = await cleanupIntegration(applied.transactionId, store);
    expect(cleaned.state).toBe("conflicted");
    expect(await readFile(plan.bridgePath, "utf8")).toContain("user changed");
  });
});
