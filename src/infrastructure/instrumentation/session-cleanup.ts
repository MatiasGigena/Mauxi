import { removeGeneratedChanges } from "./generated-file-merge";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstrumentationJournal, JournalStore } from "./journal";

async function missing(file: string): Promise<boolean> {
  try { await lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

async function liveGroup(pid: number): Promise<boolean> {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  return false;
}

export async function stopSessionProcess(journal: InstrumentationJournal): Promise<void> {
  const runtime = journal.runtime;
  if (!runtime || await missing(runtime.path)) return;
  const parent = await lstat(path.dirname(runtime.path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Session directory parent changed; preserving recovery data.");
  const info = await lstat(runtime.path);
  if (!info.isDirectory() || info.isSymbolicLink() || await readFile(path.join(runtime.path, "owner"), "utf8") !== runtime.token) throw new Error("Session directory ownership changed; preserved for recovery.");
  const receiptPath = path.join(runtime.path, "process.json");
  if (await missing(receiptPath)) return;
  const receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error("Session process receipt changed.");
  const { pid, start } = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!Number.isInteger(pid) || pid <= 1 || typeof start !== "string") throw new Error("Invalid session process receipt.");
  const statPath = `/proc/${pid}/stat`;
  if (!(await missing(statPath))) {
    const stat = await readFile(statPath, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[19] !== start || Number(fields[2]) !== pid) throw new Error("Session process identity changed; refusing to signal it.");
  } else {
    // Once the leader is gone, an extant group cannot be identified reliably
    // after an app restart. Preserve recovery data instead of killing by PID.
    if (await liveGroup(pid)) throw new Error("Session leader exited while descendants remain; stop that group before retrying cleanup.");
    return;
  }
  const signal = (value: NodeJS.Signals | 0) => {
    try { process.kill(-pid, value); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  if (!signal("SIGTERM")) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await liveGroup(pid)) await new Promise(resolve => setTimeout(resolve, 25));
  if (await liveGroup(pid)) signal("SIGKILL");
  const killedDeadline = Date.now() + 2_000;
  while (Date.now() < killedDeadline && await liveGroup(pid)) await new Promise(resolve => setTimeout(resolve, 25));
  if (await liveGroup(pid)) throw new Error("Session processes are still running; cache preserved.");
}

export async function cleanSessionFiles(journal: InstrumentationJournal, store: JournalStore): Promise<void> {
  const runtime = journal.runtime;
  if (!runtime || runtime.cleaned) return;
  if (journal.generatedTypes && !journal.generatedTypes.cleaned) {
    const record = journal.generatedTypes;
    if (!(await missing(record.path))) {
      const info = await lstat(record.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 524_288) throw new Error("Generated types path changed or exceeds its size bound; preserving it.");
      const current = await readFile(record.path, "utf8");
      if (record.cleanupAfter !== undefined && current === record.cleanupAfter) {
        // The replacement reached disk before its completion receipt did.
      } else if (current !== record.before) {
        let cleaned = record.cleanupAfter;
        if (cleaned !== undefined) {
          if (current !== record.cleanupBefore) throw new Error("Next type declarations changed after interrupted cleanup; preserved for recovery.");
        } else {
          const variants: unknown = JSON.parse(await readFile(path.join(runtime.path, "expected-types.json"), "utf8"));
          if (!Array.isArray(variants) || variants.length !== 2 || !variants.every(value => typeof value === "string" && value.length < 524_288)) throw new Error("Invalid generated types receipt.");
          const expected = variants[current.includes(".mauxi/runtime/next/dev/") ? 1 : 0] as string;
          try { cleaned = removeGeneratedChanges(current, expected, record.before ?? ""); }
          catch { throw new Error("Next type declarations overlap with session-generated changes; preserved for manual recovery."); }
          record.cleanupBefore = current;
          record.cleanupAfter = cleaned;
          await store.write(journal);
        }
        if (await readFile(record.path, "utf8") !== current) throw new Error("Next type declarations changed during cleanup; preserved for retry.");
        if (record.before === null && cleaned === "") await rm(record.path);
        else {
          const temporary = path.join(runtime.path, `types-restore-${randomUUID()}`);
          await writeFile(temporary, cleaned, { flag: "wx", mode: info.mode });
          await rename(temporary, record.path);
        }
      }
    } else if (record.before !== null) throw new Error("Generated Next types file moved or removed; preserving recovery data.");
    record.cleaned = true;
    await store.write(journal);
  }
  if (await missing(runtime.path)) {
    if (runtime.created) throw new Error("Session cache moved or removed; preserving recovery data.");
  } else {
    const info = await lstat(runtime.path);
    if (!info.isDirectory() || info.isSymbolicLink() || await readFile(path.join(runtime.path, "owner"), "utf8") !== runtime.token) throw new Error("Session cache ownership changed; preserving it.");
    await rm(runtime.path, { recursive: true });
  }
  runtime.cleaned = true;
  await store.write(journal);
  await rmdir(path.dirname(runtime.path)).catch(() => undefined);
}
