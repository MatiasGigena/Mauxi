import { expect, it } from "vitest";
import { liveGroup, type ProcessTable } from "../../src/infrastructure/instrumentation/session-cleanup";

// Well below common soft fd limits (64-256 in sandboxes and CI) once other handles are open.
const MAX_PARALLEL_READS = 16;

/** In-memory process table that tracks how many stat reads are open at once, like file descriptors would be. */
function table(stats: Map<string, string>) {
  const probe = { inFlight: 0, peak: 0, reads: 0 };

  const processes: ProcessTable = {
    pids: async () => [...stats.keys()],
    stat: async (pid) => {
      probe.reads++; probe.inFlight++; probe.peak = Math.max(probe.peak, probe.inFlight);

      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const stat = stats.get(pid);

        if (stat === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });

        return stat;
      } finally { probe.inFlight--; }
    },
  };

  return { processes, probe };
}

const stat = (pid: number, state: string, pgrp: number) => `${pid} (node) ${state} 1 ${pgrp} ${pgrp} 0`;

it("scans many processes with bounded concurrency so cleanup cannot exhaust file descriptors", async () => {
  const stats = new Map(Array.from({ length: 1_000 }, (_, index) => [String(index + 2), stat(index + 2, "S", index + 2)]));
  const { processes, probe } = table(stats);

  await expect(liveGroup(999_999, processes)).resolves.toBe(false);
  expect(probe.reads).toBe(1_000);
  expect(probe.peak).toBeLessThanOrEqual(MAX_PARALLEL_READS);
});

it("still finds a live group member, ignores zombies, and tolerates processes exiting mid-scan", async () => {
  const stats = new Map(Array.from({ length: 200 }, (_, index) => [String(index + 2), stat(index + 2, "S", index + 2)]));
  stats.set("5000", stat(5000, "Z", 4242));
  const zombieOnly = table(stats);

  await expect(liveGroup(4242, { ...zombieOnly.processes, pids: async () => [...stats.keys(), "6000"] })).resolves.toBe(false);
  stats.set("5001", stat(5001, "R", 4242));
  await expect(liveGroup(4242, table(stats).processes)).resolves.toBe(true);
});
