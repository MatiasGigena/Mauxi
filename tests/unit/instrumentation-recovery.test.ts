import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan } from "../../src/infrastructure/instrumentation/plan";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const original = "export default {\n  plugins: [\n  ],\n};\n";
async function setup(framework: "vite" | "next") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-recovery-test-")); roots.push(directory);
  const root = path.join(directory, "project"); await mkdir(root);
  await writeFile(path.join(root, framework === "vite" ? "vite.config.ts" : "next.config.mjs"), original);
  const bridge = path.join(directory, "bridge-entry.js"); await writeFile(bridge, "// disposable bridge\n");
  const store = new JournalStore(path.join(directory, "journals"));
  return { root, bridge, store, plan: await prepareIntegrationPlan(root, framework) };
}
for (const framework of ["vite", "next"] as const) {
  for (const operation of ["apply", "cleanup"] as const) {
    for (const when of ["before", "after"] as const) {
      // Next creates a client hook as well as the bridge (one extra apply write).
      const boundaries = framework === "next" && operation === "apply" ? [1, 2, 3, 4, 5] : [1, 2, 3, 4];
      it.each(boundaries)(`${framework} SIGKILL ${when} ${operation} journal write %i preserves recoverability`, async boundary => {
        const { root, bridge, store, plan } = await setup(framework);
        if (operation === "cleanup") await applyIntegration(plan, store, bridge);
        await expect(exec(process.execPath, ["--import", "tsx", path.resolve("tests/support/instrumentation-crash.ts"), root, store.directory, bridge, framework, operation, String(boundary), when])).rejects.toMatchObject({ signal: "SIGKILL" });
        const reopened = new JournalStore(store.directory);
        const journals = await reopened.list();
        for (const journal of journals) {
          const result = await cleanupIntegration(journal.transactionId, reopened);
          const again = await cleanupIntegration(journal.transactionId, new JournalStore(store.directory));
          expect(again.state).toBe(result.state);
          expect(["clean", "conflicted"]).toContain(result.state);
          if (result.state === "conflicted") expect(result.conflicts.length).toBeGreaterThan(0);
          if (result.state === "clean") {
            await expect(readFile(plan.bridgePath)).rejects.toThrow();
            if (framework === "next") await expect(readFile(plan.configPath)).rejects.toThrow();
          }
        }
        // No branch/file moves here: either exact restoration or an explicit
        // conservative conflict is valid, never loss of the user's config.
        expect(await readFile(path.join(root, framework === "vite" ? "vite.config.ts" : "next.config.mjs"), "utf8")).toBe(original);
      });
    }
  }
}
it("a failed first journal persistence changes no project file", async () => {
  const { plan, bridge, store } = await setup("vite");
  await writeFile(store.directory, "not a directory");
  await expect(applyIntegration(plan, store, bridge)).rejects.toThrow();
  expect(await readFile(plan.configPath, "utf8")).toBe(original);
  await expect(readFile(plan.bridgePath)).rejects.toThrow();
});
