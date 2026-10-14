import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { JournalStore, sha256, type InstrumentationJournal } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan, transactionIdFor } from "../../src/infrastructure/instrumentation/plan";

const exec = promisify(execFile);
const roots: string[] = [];

const targets = [
  { label: "Vite config", framework: "vite", ownedSession: false, file: "vite.config.ts" },
  { label: "Next instrumentation client", framework: "next", ownedSession: false, file: "instrumentation-client.ts" },
  { label: "Next session wrapper", framework: "next", ownedSession: true, file: "next.config.js" },
] as const;

type Target = typeof targets[number];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup(target: Target = targets[0]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-write-intent-")); roots.push(directory);
  const root = path.join(directory, "project"); await mkdir(root);

  if (target.framework === "vite") await writeFile(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
  else {
    await writeFile(path.join(root, "next.config.js"), "module.exports = { reactStrictMode: true };\n");
    await writeFile(path.join(root, "instrumentation-client.ts"), "console.info('user instrumentation');\n");
  }

  const file = path.join(root, target.file);
  const original = await readFile(file, "utf8");
  const bridge = path.join(directory, "bridge-entry.js"); await writeFile(bridge, "globalThis.__disposableBridge = true;\n");
  const store = new JournalStore(path.join(directory, "journals"));
  const plan = await prepareIntegrationPlan(root, target.framework, target.ownedSession);
  const id = transactionIdFor(plan);

  const crash = (operation: "apply" | "cleanup", boundary: string) => exec(process.execPath, [
    "--import", "tsx", path.resolve("tests/support/instrumentation-crash.ts"), root, store.directory, bridge,
    target.framework, operation, boundary, "before", target.ownedSession ? "owned" : "",
  ]);

  return { root, file, original, bridge, store, plan, id, crash };
}

for (const target of targets) {
  it(`keeps a real crashed, moved ${target.label} conflicted when original content is recreated`, async () => {
    const { root, file, original, store, id, crash } = await setup(target);
    await expect(crash("apply", `patch-written:${target.file}`)).rejects.toMatchObject({ signal: "SIGKILL" });
    const persisted = await store.read(id);
    expect(persisted.state).toBe("applying");
    expect(persisted.patches.find(patch => patch.path === file)).toMatchObject({ writeStarted: true, applied: false, appliedHash: null });
    const installed = await readFile(file, "utf8");
    expect(installed).toContain("mauxi-owned:");
    const moved = path.join(root, "moved-owned-file");
    await rename(file, moved); await writeFile(file, original);
    const result = await cleanupIntegration(id, new JournalStore(store.directory));
    expect(result.state).toBe("conflicted");
    expect(result.conflicts.some(conflict => conflict.includes(file))).toBe(true);
    expect(result.patches.find(patch => patch.path === file)?.cleaned).not.toBe(true);
    expect(await readFile(moved, "utf8")).toBe(installed);
    expect(await readFile(file, "utf8")).toBe(original);
    expect((await cleanupIntegration(id, new JournalStore(store.directory))).state).toBe("conflicted");
    await rename(moved, file);
    expect((await cleanupIntegration(id, new JournalStore(store.directory))).state).toBe("clean");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it(`recovers ${target.label} cleanup after removal but before its completion receipt`, async () => {
    const { file, original, bridge, store, plan, id, crash } = await setup(target);
    await applyIntegration(plan, store, bridge);
    await expect(crash("cleanup", `patch-cleaned:${target.file}`)).rejects.toMatchObject({ signal: "SIGKILL" });
    const persisted = await store.read(id);
    const patch = persisted.patches.find(patch => patch.path === file)!;
    expect(patch.cleaned).not.toBe(true);
    expect(patch.cleanupBeforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(patch.cleanupAfterHash).toBe(sha256(original));
    expect(await readFile(file, "utf8")).toBe(original);
    expect((await cleanupIntegration(id, new JournalStore(store.directory))).state).toBe("clean");
    expect((await cleanupIntegration(id, new JournalStore(store.directory))).state).toBe("clean");
    expect(await readFile(file, "utf8")).toBe(original);
  });
}

it.each(["before", "after"] as const)("fails safely when mutation intent persistence fails %s the receipt", async when => {
  const { file, original, bridge, store, plan, id } = await setup();

  class FailingStore extends JournalStore {
    override async write(journal: InstrumentationJournal) {
      const started = journal.patches.some(patch => patch.writeStarted && !patch.applied);

      if (started && when === "before") throw new Error("Mutation intent persistence failed");
      await super.write(journal);

      if (started && when === "after") throw new Error("Mutation intent persistence failed");
    }
  }

  await expect(applyIntegration(plan, new FailingStore(store.directory), bridge)).rejects.toThrow("Mutation intent persistence failed");
  expect(await readFile(file, "utf8")).toBe(original);
  const persisted = await store.read(id);
  expect(persisted.patches[0].writeStarted).toBe(when === "after");
  expect((await cleanupIntegration(id, store)).state).toBe(when === "before" ? "clean" : "conflicted");
  expect(await readFile(file, "utf8")).toBe(original);
});

it.each(["present", "absent"] as const)("recovers a legacy unconfirmed patch with owned markers %s conservatively", async markers => {
  const { file, original, bridge, store, plan, id } = await setup();
  const journal = await applyIntegration(plan, store, bridge);
  journal.state = "applying";
  delete journal.patches[0].writeStarted;
  journal.patches[0].applied = false;
  journal.patches[0].appliedHash = null;
  await store.write(journal);

  if (markers === "absent") await writeFile(file, original);
  expect((await cleanupIntegration(id, store)).state).toBe(markers === "present" ? "clean" : "conflicted");
  expect(await readFile(file, "utf8")).toBe(original);
});

for (const target of targets) {
  it(`preserves ${target.label} edits arriving while mutation intent is persisted`, async () => {
    const { file, original, bridge, store, plan, id } = await setup(target);
    const userEdit = "\nconst userChange = true;\n";
    let edited = false;

    class EditingStore extends JournalStore {
      override async write(journal: InstrumentationJournal) {
        await super.write(journal);

        if (!edited && journal.patches.some(patch => patch.path === file && patch.writeStarted && !patch.applied)) {
          edited = true;
          await writeFile(file, original + userEdit);
        }
      }
    }

    await expect(applyIntegration(plan, new EditingStore(store.directory), bridge)).rejects.toThrow(/changed/);
    expect(edited).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original + userEdit);
    expect((await cleanupIntegration(id, store)).state).toBe("conflicted");
    expect(await readFile(file, "utf8")).toBe(original + userEdit);
  });

  it(`preserves ${target.label} edits arriving during cleanup intent and safely retries`, async () => {
    const { file, original, bridge, store, plan, id } = await setup(target);
    await applyIntegration(plan, store, bridge);
    const installed = await readFile(file, "utf8");
    const userEdit = "\nconst userChange = true;\n";
    let edited = false;

    class EditingStore extends JournalStore {
      override async write(journal: InstrumentationJournal) {
        await super.write(journal);

        if (!edited && journal.patches.some(patch => patch.path === file && patch.cleanupAfterHash !== undefined && !patch.cleaned)) {
          edited = true;
          await writeFile(file, installed + userEdit);
        }
      }
    }

    const result = await cleanupIntegration(id, new EditingStore(store.directory));
    expect(result.state).toBe("conflicted");
    expect(result.conflicts.some(conflict => conflict.includes("changed during cleanup"))).toBe(true);
    expect(await readFile(file, "utf8")).toBe(installed + userEdit);
    expect((await cleanupIntegration(id, store)).state).toBe("clean");
    expect(await readFile(file, "utf8")).toBe(original + userEdit);
  });
}

it("does not mistake edits after an interrupted cleanup for its completed output", async () => {
  const { file, original, bridge, store, plan, id, crash } = await setup();
  await applyIntegration(plan, store, bridge);
  await expect(crash("cleanup", "patch-cleaned:vite.config.ts")).rejects.toMatchObject({ signal: "SIGKILL" });
  const userContent = original + "\nconst laterUserChange = true;\n";
  await writeFile(file, userContent);
  expect((await cleanupIntegration(id, store)).state).toBe("conflicted");
  expect(await readFile(file, "utf8")).toBe(userContent);
});
