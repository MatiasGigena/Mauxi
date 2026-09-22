// Release gates intentionally assert the required behavior, not the known bug.
// Run explicitly with `npm run test:release-gates`; failures block issue #9.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan } from "../../src/infrastructure/instrumentation/plan";
import { OwnedDevProcess } from "../../src/infrastructure/project/dev-process";
import type { LaunchPlan } from "../../src/application/project-contract";

it.each(["moved-artifact", "moved-unpersisted-patch"])("does not declare clean with %s still present", async scenario => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-release-move-"));
  try {
    const root = path.join(directory, "project"); await mkdir(root);
    await writeFile(path.join(root, "vite.config.ts"), "export default {\n plugins: [\n ],\n};\n");
    const bridge = path.join(directory, "bridge-entry.js"); await writeFile(bridge, "// owned bridge\n");
    const store = new JournalStore(path.join(directory, "journals"));
    const plan = await prepareIntegrationPlan(root, "vite");
    const journal = await applyIntegration(plan, store, bridge);
    const moved = path.join(root, "moved-owned-file");
    if (scenario === "moved-artifact") await rename(plan.bridgePath, moved);
    else {
      // Crash after patch installation but before the applied flag is durable,
      // then a branch/file move before next-launch recovery.
      journal.state = "applying"; journal.patches[0].applied = false;
      await store.write(journal); await rename(plan.configPath, moved);
    }
    const result = await cleanupIntegration(journal.transactionId, new JournalStore(store.directory));
    expect(await readFile(moved, "utf8")).toContain(scenario === "moved-artifact" ? "owned bridge" : "mauxi-owned:start");
    expect(result.state, "Residual owned content must require manual resolution, not a clean receipt").toBe("conflicted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("stops an owned dev descendant after the launcher exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-release-process-"));
  let leader: number | null = null; let child = 0; let exited = false;
  const owner = new OwnedDevProcess(() => undefined, () => { exited = true; });
  try {
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));child.unref();`;
    owner.start({ appRoot: root, executable: process.execPath, args: ["-e", script] } as LaunchPlan);
    leader = owner.pid;
    await vi.waitFor(async () => { child = Number(await readFile(path.join(root, "child.pid"), "utf8")); expect(child).toBeGreaterThan(0); expect(exited).toBe(true); });
    await owner.stop(100);
    const active = async () => { try { return !(await readFile(`/proc/${child}/stat`, "utf8")).split(") ")[1].startsWith("Z "); } catch { return false; } };
    await vi.waitFor(async () => expect(await active(), "A dev launcher exit must not lose ownership of its process group").toBe(false), { timeout: 1000 });
  } finally {
    // Only the process group this test started; never kill by port/name.
    if (leader) { try { process.kill(-leader, "SIGKILL"); } catch { /* already stopped */ } }
    await rm(root, { recursive: true, force: true });
  }
});
