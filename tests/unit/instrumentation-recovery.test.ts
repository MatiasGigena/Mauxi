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

for (const framework of ["vite", "next"] as const) {
  it.each(["branch-switch", "tracked-file-move"])(`${framework} recovery preserves real Git %s changes and reports displaced hooks`, async scenario => {
    const { root, bridge, store } = await setup(framework);
    const file = framework === "vite" ? "vite.config.ts" : "instrumentation-client.ts";
    if (framework === "next") await writeFile(path.join(root, file), "// original client instrumentation\n");
    const git = (...args: string[]) => exec("git", ["-c", "user.name=Mauxi fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    await git("init", "-q", "-b", "baseline"); await git("add", "."); await git("commit", "-qm", "test(fixture): establish baseline");
    await git("switch", "-qc", "other");
    const otherContent = framework === "vite" ? "export default { plugins: [], server: { port: 4321 } };\n" : "// other branch instrumentation\n";
    await writeFile(path.join(root, file), otherContent);
    await git("commit", "-qam", "test(fixture): change integration file");
    await git("switch", "-q", "baseline");
    const plan = await prepareIntegrationPlan(root, framework);
    const journal = await applyIntegration(plan, store, bridge);
    if (scenario === "branch-switch") await git("switch", "--discard-changes", "other");
    else await git("mv", file, "moved-hook.ts");
    const before = (await git("diff", "--cached", "--binary")).stdout;
    const result = await cleanupIntegration(journal.transactionId, new JournalStore(store.directory));
    expect(result.state).toBe("conflicted");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect((await git("diff", "--cached", "--binary")).stdout).toBe(before);
    if (scenario === "branch-switch") expect(await readFile(path.join(root, file), "utf8")).toBe(otherContent);
    else expect(await readFile(path.join(root, "moved-hook.ts"), "utf8")).toContain("mauxi-owned:start");
    expect((await cleanupIntegration(journal.transactionId, new JournalStore(store.directory))).state).toBe("conflicted");
  });
}
