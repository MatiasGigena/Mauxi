import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../instrumentation/journal";
import type { AgentChangeFileView, AgentChangeSetView } from "../../application/agent-contract";
import { inspectLinuxMetadata, inspectLinuxPath, METADATA_LIMITATION, type LinuxFileMetadata } from "./linux-file-metadata";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SET_BYTES = 10 * 1024 * 1024;
const MAX_CHANGE_SETS = 64;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
export const RECOVERY_VAULT_LIMITS = { entries: 128, bytes: 128 * 1024 * 1024 } as const;
// Electron enforces a single app instance. Also serialize vault admission across
// coordinators in that process, not just operations within one workspace.
const vaultTails = new Map<string, Promise<unknown>>();
class MutationNotStartedError extends Error {}
const EXCLUDED_DIRECTORIES = new Set([".git", ".mauxi", "node_modules", ".next", "dist", "dist-electron", "build", "release", "coverage", ".cache", "playwright-report", "test-results"]);

type ChangeState = "prepared" | "active" | "settled" | "failed" | "undoing" | "undone" | "conflicted";
type ChangeKind = "create" | "modify" | "delete";

interface FileRecord {
  path: string;
  kind: ChangeKind;
  beforeContent: string | null;
  afterContent: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  mode?: number;
  beforeMetadata?: LinuxFileMetadata;
  installedMetadata?: LinuxFileMetadata | null;
  attribution: "managed" | "command";
  pending: boolean;
  commandPending?: boolean;
  reviewWarning?: string;
  nonUndoable?: boolean;
}

interface StoredChangeSet {
  id: string;
  label: string;
  state: ChangeState;
  createdAt: string;
  updatedAt: string;
  files: FileRecord[];
  baseline?: Record<string, string>;
  baselineIncomplete?: boolean;
  unexpectedPaths: string[];
  coverageWarnings: string[];
  errors: string[];
  recoveries?: Array<{ path: string; directory: string; status: "prepared" | "retained" }>;
}

interface ChangeStore {
  version: 1;
  workspaceId: string;
  workspaceRoot: string;
  activeId?: string;
  changeSets: StoredChangeSet[];
  blockedReason?: string;
}

interface FileSnapshot {
  path: string;
  content: string | null;
  hash: string | null;
  mode?: number;
  identity?: string;
  metadata?: LinuxFileMetadata;
}

function fileIdentity(info: Stats): string {
  // rename changes ctime, but preserves inode, mode, size and mtime.
  return `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}:${info.size}:${info.mtimeMs}`;
}

export interface CommandCheckpoint {
  changeSetId: string;
  covered: FileSnapshot[];
  workspace: Map<string, string>;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(value: string): string { return value.split(path.sep).join("/"); }

function protectedPath(relative: string): boolean {
  const parts = displayPath(relative).split("/");
  const name = parts.at(-1) ?? "";
  return parts.includes(".git") || parts.includes(".mauxi") || parts.some((part) => part.startsWith(".mauxi-recovery-"))
    || /^\.env(?:\.|$)/i.test(name)
    || /^(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || [".npmrc", ".pypirc", ".netrc"].includes(name);
}

function boundedLabel(label: string): string {
  const compact = label.trim().replace(/\s+/g, " ");
  return compact.slice(0, 120) || "Agent request";
}

function lines(value: string | null): string[] { return value === null ? [] : value.split("\n"); }

/** A bounded, readable line diff. It deliberately falls back to a summary for large files. */
export function changeDiff(before: string | null, after: string | null): string {
  if (before === after) return "";
  const summary = (left: number, right: number) => `--- before (${left} lines)\n+++ after (${right} lines)\n@@ Diff is too large for inline review @@`;
  if (Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "") > 100_000) {
    const count = (value: string | null) => {
      if (value === null) return 0;
      let total = 1; let position = -1;
      while ((position = value.indexOf("\n", position + 1)) !== -1) total++;
      return total;
    };
    return summary(count(before), count(after));
  }
  const left = lines(before); const right = lines(after);
  if (left.length * right.length > 250_000 || left.length + right.length > 4_000) return summary(left.length, right.length);
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const output = ["--- before", "+++ after"];
  let i = 0; let j = 0; let bytes = Buffer.byteLength(output.join("\n"));
  while (i < left.length || j < right.length) {
    let line: string;
    if (i < left.length && j < right.length && left[i] === right[j]) { line = ` ${left[i]}`; i++; j++; }
    else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) line = `+${right[j++]}`;
    else line = `-${left[i++]}`;
    const nextBytes = Buffer.byteLength(line) + 1;
    if (bytes + nextBytes > 119_900) { output.push("… diff truncated …"); break; }
    output.push(line); bytes += nextBytes;
  }
  return output.join("\n");
}

export class ChangeCoordinator {
  private store: ChangeStore;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly workspaceId: string,
    readonly root: string,
    private readonly filePath: string,
    private readonly repositoryBoundary: string,
    initial?: ChangeStore,
  ) {
    this.store = initial ?? { version: 1, workspaceId, workspaceRoot: root, changeSets: [] };
  }

  static async create(workspaceId: string, workspaceRoot: string, directory: string): Promise<ChangeCoordinator> {
    const root = await realpath(workspaceRoot);
    let repositoryBoundary = root;
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      const git = await lstat(path.join(ancestor, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
        throw error;
      });
      if (git) { repositoryBoundary = ancestor; break; }
      if (path.dirname(ancestor) === ancestor) break;
    }
    if (inside(repositoryBoundary, path.resolve(directory))) throw new Error("Checkpoint storage and its recovery vault must be outside the project and its repository.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const storage = await realpath(directory);
    if (inside(repositoryBoundary, storage)) throw new Error("Checkpoint storage and its recovery vault must be outside the project and its repository.");
    const filePath = path.join(storage, `${sha256(root).slice(0, 24)}.json`);
    let initial: ChangeStore | undefined;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as ChangeStore;
      if (parsed.version === 1 && parsed.workspaceRoot === root && Array.isArray(parsed.changeSets)) { parsed.workspaceId = workspaceId; initial = parsed; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Checkpoint recovery is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const coordinator = new ChangeCoordinator(workspaceId, root, filePath, repositoryBoundary, initial);
    await coordinator.reconcileInterruptedState();
    return coordinator;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const temporaryFile = await open(temporary, "wx", 0o600);
    try {
      try { await temporaryFile.writeFile(`${JSON.stringify(this.store, null, 2)}\n`); await temporaryFile.sync(); }
      finally { await temporaryFile.close(); }
      await rename(temporary, this.filePath);
      const directory = await open(path.dirname(this.filePath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      // This is unexposed app-owned metadata staging, never a displaced inode.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async reconcileInterruptedState(): Promise<void> {
    let changed = false;
    for (const set of this.store.changeSets) {
      if (set.state === "prepared" || set.state === "active" || set.state === "undoing") {
        const previousState = set.state;
        set.state = previousState === "undoing" ? "conflicted" : "failed";
        set.errors.push(set.state === "conflicted" ? "Undo was interrupted. Review current files before resolving it." : previousState === "prepared" ? "A queued request did not start before Mauxi stopped." : "Mauxi stopped before this request settled; partial changes were retained.");
        changed = true;
      }
      for (const recovery of set.recoveries ?? []) {
        if (!path.isAbsolute(recovery.directory)) {
          const warning = `Legacy in-project recovery remains at ${path.resolve(this.root, recovery.directory)}. It is preserved and pins this record, but is outside the external vault quota. Stop all writers and review intent.json before manual cleanup; new mutations never create in-project recovery artifacts.`;
          if (!set.coverageWarnings.includes(warning)) { set.coverageWarnings.push(warning); changed = true; }
        }
        if (recovery.status === "prepared") {
          set.state = "conflicted";
          set.errors.push(`Interrupted mutation of ${recovery.path}. Original/displaced data and any replacement are retained in ${recovery.directory}; no automatic recovery overwrites project files.`);
          changed = true;
        }
      }
      for (const file of set.files.filter((item) => item.pending)) {
        if (file.commandPending || file.attribution === "command") {
          await this.observeCommandFile(set, file);
          set.coverageWarnings.push("Interrupted command: current covered files are a bounded partial observation, not proven command output. External and undeclared effects cannot be reconstructed or automatically undone.");
          changed = true;
          continue;
        }
        const current = await this.readRelative(file.path, true).catch(() => undefined);
        if (current && this.matchesInstalled(file, current)) file.pending = false;
        else if (current?.hash === file.beforeHash) { file.pending = false; file.afterHash = file.beforeHash; file.afterContent = file.beforeContent; set.errors.push(`A prepared write to ${file.path} did not reach the project.`); }
        else { set.state = "conflicted"; set.errors.push(`Interrupted write state is ambiguous for ${file.path}.`); }
        changed = true;
      }
      for (const file of set.files) {
        if (file.attribution === "managed" && file.beforeHash !== file.afterHash && file.installedMetadata === undefined) {
          file.nonUndoable = true;
          const warning = `Installed inode/metadata was not durably recorded for ${file.path}; review only, no automatic undo (legacy or interrupted checkpoint).`;
          if (!set.coverageWarnings.includes(warning)) { set.coverageWarnings.push(warning); changed = true; }
        }
      }
    }
    if (this.store.activeId) { delete this.store.activeId; changed = true; }
    if (changed) await this.persist();
  }

  private current(): StoredChangeSet {
    if (this.store.blockedReason) throw new Error(`Managed writes are blocked: ${this.store.blockedReason}`);
    const set = this.store.changeSets.find((item) => item.id === this.store.activeId);
    if (!set || set.state !== "active") throw new Error("No active request checkpoint. The write was blocked.");
    return set;
  }

  private async captureBaseline(set: StoredChangeSet): Promise<void> {
    const baseline = await this.scanWorkspace();
    set.baselineIncomplete = baseline.delete("<coverage-limit>");
    set.baseline = Object.fromEntries(baseline);
    if (set.baselineIncomplete) set.coverageWarnings.push("The request baseline reached its 2,000-file or 20 MiB coverage limit; changes to files outside that snapshot may be unattributable.");
  }

  private undoEligible(set: StoredChangeSet): boolean {
    return (set.state === "settled" || set.state === "failed")
      && set.files.some((file) => file.beforeHash !== file.afterHash)
      && !set.files.some((file) => file.pending || file.nonUndoable || file.attribution === "command");
  }

  private async pruneCompletedForCapacity(changeSets: StoredChangeSet[]): Promise<StoredChangeSet[]> {
    // Never orphan recovery by pruning its review record. Only an explicitly
    // removed retained directory releases this pin; unfinished intent stays pinned.
    for (const set of changeSets) {
      const retainedRecoveries = [];
      for (const recovery of set.recoveries ?? []) {
        const exists = await lstat(path.resolve(this.root, recovery.directory)).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
        if (recovery.status === "prepared" || exists) retainedRecoveries.push(recovery);
      }
      set.recoveries = retainedRecoveries;
    }
    const retained = [...changeSets];
    if (retained.length < MAX_CHANGE_SETS) return retained;
    const latestEligible = [...retained].reverse().find((item) => this.undoEligible(item));
    const rank = (item: StoredChangeSet): number => {
      if (item.recoveries?.length) return 99;
      if (item.state === "undone") return 0;
      if ((item.state === "settled" || item.state === "failed") && !item.files.some((file) => file.beforeHash !== file.afterHash)) return 1;
      if ((item.state === "settled" || item.state === "failed") && item.id !== latestEligible?.id) return 2;
      return 99;
    };
    for (const candidate of [...retained].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt))) {
      if (retained.length < MAX_CHANGE_SETS || rank(candidate) === 99) break;
      retained.splice(retained.findIndex((item) => item.id === candidate.id), 1);
    }
    return retained;
  }

  async prepare(label: string): Promise<string> {
    return this.exclusive(async () => {
      if (this.store.blockedReason) throw new Error(`Cannot create checkpoint: ${this.store.blockedReason}`);
      const unfinished = this.store.changeSets.filter((item) => item.state === "prepared" || item.state === "active" || item.state === "undoing");
      if (unfinished.length >= 8) throw new Error("Checkpoint storage has eight unfinished operations. Resolve them before sending another request.");
      const previous = this.store.changeSets;
      this.store.changeSets = await this.pruneCompletedForCapacity(previous);
      if (this.store.changeSets.length >= MAX_CHANGE_SETS) { this.store.changeSets = previous; throw new Error("Checkpoint storage is full of active, conflicted, or retained recovery records. Review and manually clean resolved vault entries before sending another request."); }
      const now = new Date().toISOString();
      const set: StoredChangeSet = {
        id: randomUUID(), label: boundedLabel(label), state: "prepared", createdAt: now, updatedAt: now, files: [],
        unexpectedPaths: [], coverageWarnings: [], errors: [],
      };
      this.store.changeSets.push(set);
      try { await this.persist(); }
      catch (error) { this.store.changeSets = previous; throw new Error(`Checkpoint could not be persisted; no managed writes are allowed: ${error instanceof Error ? error.message : String(error)}`); }
      return set.id;
    });
  }

  async activate(id: string): Promise<void> {
    await this.exclusive(async () => {
      const set = this.store.changeSets.find((item) => item.id === id);
      if (!set || set.state !== "prepared") throw new Error("Prepared checkpoint is unavailable.");
      if (this.store.activeId && this.store.activeId !== id) throw new Error("Another request checkpoint is active.");
      await this.captureBaseline(set);
      set.state = "active"; set.updatedAt = new Date().toISOString(); this.store.activeId = id;
      await this.persist();
    });
  }

  async switchToPrepared(id: string): Promise<void> {
    await this.exclusive(async () => {
      const next = this.store.changeSets.find((item) => item.id === id);
      if (!next || next.state !== "prepared") throw new Error("Queued request checkpoint is unavailable.");
      const current = this.store.changeSets.find((item) => item.id === this.store.activeId);
      if (current) { current.state = "settled"; current.updatedAt = new Date().toISOString(); }
      try {
        await this.captureBaseline(next);
        next.state = "active"; next.updatedAt = new Date().toISOString(); this.store.activeId = id;
        await this.persist();
      } catch (error) {
        // The host already dequeued this request. Retire its record here, and
        // never let tools queued behind a failed activation use the old set.
        next.state = "failed"; next.updatedAt = new Date().toISOString();
        next.errors.push(`Queued checkpoint activation failed: ${error instanceof Error ? error.message : String(error)}`);
        delete this.store.activeId;
        try { await this.persist(); }
        catch { this.store.blockedReason = "queued checkpoint failure could not be persisted"; }
        throw error;
      }
    });
  }

  async settle(failed = false, message?: string): Promise<void> {
    await this.exclusive(async () => {
      const set = this.store.changeSets.find((item) => item.id === this.store.activeId);
      if (!set) return;
      if (set.state !== "conflicted") set.state = failed ? "failed" : "settled";
      if (message) set.errors.push(message.slice(0, 1_000));
      set.updatedAt = new Date().toISOString(); delete this.store.activeId;
      await this.persist();
    });
  }

  async abandonPrepared(id: string, reason: string): Promise<void> {
    await this.exclusive(async () => {
      const set = this.store.changeSets.find((item) => item.id === id);
      if (!set || set.state !== "prepared") return;
      set.state = "failed"; set.errors.push(reason.slice(0, 1_000)); set.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  private lexicalPath(input: string): { absolute: string; relative: string } {
    if (!input || input.includes("\0") || path.isAbsolute(input)) throw new Error("Use a relative path inside the open project.");
    const absolute = path.resolve(this.root, input);
    if (!inside(this.root, absolute)) throw new Error("Path escapes the open project.");
    const relative = displayPath(path.relative(this.root, absolute));
    if (!relative || protectedPath(relative)) throw new Error("This path is protected from agent writes.");
    return { absolute, relative };
  }

  /**
   * Anchor mutations to an open Linux directory descriptor. A parent that is
   * swapped for a symlink either resolves outside the workspace and is rejected,
   * or leaves this descriptor pointing at the originally validated directory.
   */
  private async withAnchoredParent<T>(input: string, operation: (target: string) => Promise<T>): Promise<T> {
    const resolved = this.lexicalPath(input);
    const parent = path.dirname(resolved.absolute);
    let directory;
    try { directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Parent directory does not exist for ${resolved.relative}. Create directories outside the managed write tool first.`);
      if ((error as NodeJS.ErrnoException).code === "ELOOP" || (error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error(`Agent writes require a real, non-symbolic-link parent directory: ${resolved.relative}`);
      throw error;
    }
    try {
      const descriptorPath = `/proc/self/fd/${directory.fd}`;
      const canonicalParent = await realpath(descriptorPath);
      if (!inside(this.root, canonicalParent)) throw new Error("Resolved parent directory escapes the open project.");
      return await operation(path.join(descriptorPath, path.basename(resolved.absolute)));
    } finally { await directory.close(); }
  }

  private async readRelative(input: string, allowMissing: boolean): Promise<FileSnapshot> {
    const resolved = this.lexicalPath(input);
    return this.withAnchoredParent(resolved.relative, async (target) => {
      let file;
      try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return { path: resolved.relative, content: null, hash: null };
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Agent writes cannot follow symbolic links: ${resolved.relative}`);
        throw error;
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`File is not a bounded regular text file: ${resolved.relative}`);
        const metadata = await inspectLinuxMetadata(file);
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_FILE_BYTES) throw new Error(`File grew beyond bounded text coverage: ${resolved.relative}`);
        const content = buffer.subarray(0, bytesRead).toString("utf8");
        if (content.includes("\0")) throw new Error(`Binary files cannot be checkpointed: ${resolved.relative}`);
        if (fileIdentity(await file.stat()) !== fileIdentity(info)) throw new Error(`File changed during metadata inspection: ${resolved.relative}`);
        return { path: resolved.relative, content, hash: sha256(content), mode: info.mode, identity: fileIdentity(info), metadata };
      } finally { await file.close(); }
    });
  }

  private setSize(set: StoredChangeSet): number {
    return set.files.reduce((sum, file) => sum + Buffer.byteLength(file.beforeContent ?? "") + Buffer.byteLength(file.afterContent ?? ""), 0);
  }

  private assertRequestBaseline(set: StoredChangeSet, before: FileSnapshot, existing?: FileRecord): void {
    if (existing) return;
    const baseline = set.baseline ?? {};
    const covered = Object.prototype.hasOwnProperty.call(baseline, before.path);
    if (set.baselineIncomplete && !covered) throw new Error(`File was outside this request's bounded baseline: ${before.path}. Start a new request after reducing project coverage.`);
    const expected = covered ? baseline[before.path] : null;
    if (expected !== before.hash) throw new Error(`File changed after this request checkpoint was created: ${before.path}`);
  }

  private get vaultPath(): string { return path.join(path.dirname(this.filePath), "recovery"); }

  private async withRecoveryVault<T>(target: string, reservedBytes: number, operation: (descriptor: string, canonical: string) => Promise<T>): Promise<T> {
    const previous = vaultTails.get(this.vaultPath) ?? Promise.resolve();
    const result = previous.then(async () => {
      let directory; let started = false;
      try {
        await mkdir(this.vaultPath, { mode: 0o700, recursive: true });
        directory = await open(this.vaultPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const descriptor = `/proc/self/fd/${directory.fd}`;
        const canonical = await realpath(descriptor);
        if (inside(this.repositoryBoundary, canonical)) throw new Error("Recovery vault must be outside the project and its repository; no in-project fallback is allowed.");
        const vaultInfo = await stat(descriptor);
        if (vaultInfo.dev !== (await stat(path.dirname(target))).dev) {
          throw new Error(`The recovery vault (${canonical}) and target are on different filesystems. Atomic no-clobber recovery is unavailable. Move the app-owned checkpoint storage to the project filesystem; this file was not mutated and no in-project fallback is allowed.`);
        }
        // Count actual retained data, including orphaned/interrupted entries and
        // bytes added by external writers. Checkpoint pruning never frees quota.
        const entries = await readdir(descriptor, { withFileTypes: true });
        let bytes = Math.max(vaultInfo.size, vaultInfo.blocks * 512);
        const full = () => new Error(`Recovery vault limit (${RECOVERY_VAULT_LIMITS.entries} entries / ${RECOVERY_VAULT_LIMITS.bytes / 1024 / 1024} MiB) reached at ${canonical}. Stop external writers, review intent.json, and manually clean resolved entries. This file was not mutated.`);
        const unexpected = entries.find((entry) => !entry.isDirectory() || entry.isSymbolicLink());
        if (unexpected) throw new Error(`Unexpected recovery vault entry: ${unexpected.name}. Review it manually before further mutations.`);
        if (entries.length >= RECOVERY_VAULT_LIMITS.entries) throw full();
        for (const entry of entries) {
          const entryInfo = await lstat(path.join(descriptor, entry.name));
          if (!entryInfo.isDirectory()) throw new Error(`Recovery directory changed: ${entry.name}. Review it manually before further mutations.`);
          bytes += Math.max(entryInfo.size, entryInfo.blocks * 512);
          const files = await readdir(path.join(descriptor, entry.name), { withFileTypes: true });
          if (files.length > 3) throw new Error(`Unexpected recovery entry contents: ${entry.name}. Review them manually before further mutations.`);
          for (const file of files) {
            const info = await lstat(path.join(descriptor, entry.name, file.name));
            // A raced target can be a symlink; retain/count it, never follow it.
            if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Unsupported retained recovery data in ${entry.name}. Review it manually before further mutations.`);
            bytes += Math.max(info.size, info.blocks * 512);
            if (bytes + reservedBytes > RECOVERY_VAULT_LIMITS.bytes) throw full();
          }
        }
        if (bytes + reservedBytes > RECOVERY_VAULT_LIMITS.bytes) throw full();
        started = true;
        return await operation(descriptor, canonical);
      } catch (error) {
        if (!started) throw new MutationNotStartedError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally { await directory?.close(); }
    });
    const tail = result.then(() => undefined, () => undefined);
    vaultTails.set(this.vaultPath, tail);
    try { return await result; }
    finally { if (vaultTails.get(this.vaultPath) === tail) vaultTails.delete(this.vaultPath); }
  }

  /**
   * Linux no-clobber replacement: displace into a private recovery directory,
   * validate the displaced inode, then link the staged inode into the empty name.
   * link(2) never overwrites a concurrent arrival. We never unlink displaced data:
   * even a writer holding the old inode open can recover its late writes.
   */
  private async mutate(set: StoredChangeSet, relative: string, expectedHash: string | null, content: string | null, metadata?: LinuxFileMetadata, expectedIdentity?: string, expectedMetadata = metadata, restoreTimestamps = false): Promise<LinuxFileMetadata | null> {
    return this.withAnchoredParent(relative, async (target) => {
      let parentMetadata: LinuxFileMetadata; let creationMetadata: LinuxFileMetadata | undefined;
      try {
        parentMetadata = await inspectLinuxPath(`${path.dirname(target)}/.`);
        if (!metadata && content !== null) creationMetadata = await inspectLinuxPath(`${path.dirname(target)}/.`, true);
      } catch (error) { throw new MutationNotStartedError(error instanceof Error ? error.message : String(error)); }
      const checkParent = async () => {
        const current = await inspectLinuxPath(`${path.dirname(target)}/.`);
        if ((["mode", "uid", "gid"] as const).some((key) => current[key] !== parentMetadata[key])) throw new Error("Target-directory metadata changed during mutation");
      };
      const preserved = metadata ?? (content === null ? expectedMetadata : undefined);
      const desired = preserved ? {
        mode: preserved.mode, uid: preserved.uid, gid: preserved.gid, atimeNs: preserved.atimeNs,
        ...(restoreTimestamps ? { mtimeNs: preserved.mtimeNs } : {}),
      } : { mode: creationMetadata?.mode ?? 0, uid: creationMetadata?.uid ?? 0, gid: creationMetadata?.gid ?? 0 };
      const name = `${sha256(this.root).slice(0, 24)}-${randomUUID()}`;
      const intent = JSON.stringify({ workspaceRoot: this.root, path: relative, expectedHash, expectedIdentity, afterHash: content === null ? null : sha256(content), changeSetId: set.id });
      // Reserve the full bounded target allowance plus staged data and filesystem
      // block overhead. External inode growth cannot be capped without data loss.
      const reservedBytes = (expectedHash === null ? 0 : MAX_FILE_BYTES) + Buffer.byteLength(content ?? "") + Buffer.byteLength(intent) + 3 * 4096;
      return this.withRecoveryVault(target, reservedBytes, async (vault, canonicalVault) => {
        const directory = path.join(vault, name);
        const recovery = { path: relative, directory: path.join(canonicalVault, name), status: "prepared" as "prepared" | "retained" };
        const sync = async (file: string) => { const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); } };
        const backup = path.join(directory, "displaced"); const staged = path.join(directory, "replacement");
        let created = false; let preparedMetadata: LinuxFileMetadata | undefined;
        try {
          await mkdir(directory, { mode: 0o700 }); created = true;
          await writeFile(path.join(directory, "intent.json"), intent, { flag: "wx", mode: 0o600 });
          await sync(path.join(directory, "intent.json"));
          if (content !== null) {
            await writeFile(staged, content, { mode: 0o600, flag: "wx" });
            const replacement = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { preparedMetadata = await inspectLinuxMetadata(replacement, desired); await replacement.sync(); }
            finally { await replacement.close(); }
          } else if (preserved) {
            // Before deleting, prove that undo can reproduce this ownership/mode
            // on a fresh vault inode. The empty O_TMPFILE probe has no pathname.
            const probeParent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { await inspectLinuxMetadata(probeParent, desired, true); }
            finally { await probeParent.close(); }
          }
          if (expectedHash !== null) {
            const original = await inspectLinuxPath(target);
            if (!expectedMetadata || original.changeIdentity !== expectedMetadata.changeIdentity) throw new Error("File metadata changed before mutation");
          }
          await checkParent();
          await sync(directory); await sync(vault); await sync(path.dirname(canonicalVault));
          (set.recoveries ??= []).push(recovery);
          await this.persist();
        } catch (error) {
          // No project inode has been displaced yet; only staging data is ours.
          if (created) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          await sync(vault).catch(() => undefined);
          // Removing this reference cannot erase displaced data: project mutation
          // has not begun. Any cleanup failure remains counted by the vault scan.
          set.recoveries = set.recoveries?.filter((item) => item !== recovery);
          throw new MutationNotStartedError(error instanceof Error ? error.message : String(error));
        }
        try {
          if (expectedHash !== null) {
            // The destination is absent inside a newly created private directory.
            // Unlike replacing the project name, this rename cannot lose its data.
            await rename(target, backup);
            await sync(directory); await sync(path.dirname(target));
            const displaced = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const info = await displaced.stat();
              const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
              const { bytesRead } = await displaced.read(buffer, 0, buffer.length, 0);
              await displaced.sync();
              if (!info.isFile() || (expectedIdentity && fileIdentity(info) !== expectedIdentity) || (await inspectLinuxMetadata(displaced)).identity !== expectedMetadata?.identity || info.size > MAX_FILE_BYTES || bytesRead > MAX_FILE_BYTES || sha256(buffer.subarray(0, bytesRead)) !== expectedHash) throw new Error("Displaced file changed after revalidation");
            } finally { await displaced.close(); }
          }
          await checkParent();
          if (content !== null) await link(staged, target); // EEXIST is a conflict, never overwrite.
          else {
            // A new arrival after displacement is not ours to delete.
            try { await lstat(target); throw new Error("File arrived during deletion"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          await sync(path.dirname(target));
          if (expectedHash !== null) {
            const displaced = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
              const { bytesRead } = await displaced.read(buffer, 0, buffer.length, 0);
              await displaced.sync();
              if ((expectedIdentity && fileIdentity(await displaced.stat()) !== expectedIdentity) || (await inspectLinuxMetadata(displaced)).identity !== expectedMetadata?.identity || bytesRead > MAX_FILE_BYTES || sha256(buffer.subarray(0, bytesRead)) !== expectedHash) throw new Error("Displaced inode changed during installation; its external data is retained");
            } finally { await displaced.close(); }
          }
          await checkParent();
          const installed = content === null ? null : await inspectLinuxPath(target);
          if (installed && (installed.identity !== preparedMetadata?.identity || installed.mode !== desired.mode || installed.uid !== desired.uid || installed.gid !== desired.gid)) throw new Error("Installed inode/metadata changed during installation");
          recovery.status = "retained";
          const warning = `Mutation recovery data is retained outside the project in ${canonicalVault} (128 entries / 128 MiB admission limit). Stop external writers and review intent.json before manual cleanup. Displaced/exposed inodes are never automatically deleted, and retained entries pin their checkpoint records.`;
          if (!set.coverageWarnings.includes(warning)) set.coverageWarnings.push(warning);
          if (!set.coverageWarnings.includes(METADATA_LIMITATION)) set.coverageWarnings.push(METADATA_LIMITATION);
          await this.persist();
          return installed;
        } catch (error) {
          // Restore only into an empty name. If another writer won the name, both
          // versions survive and the durable manifest tells the user where to look.
          if (expectedHash !== null) await link(backup, target).catch(() => undefined);
          await sync(path.dirname(target));
          set.state = "conflicted";
          set.errors.push(`Mutation stopped safely for ${relative}: ${error instanceof Error ? error.message : String(error)}. Review ${recovery.directory}; displaced/replacement data was retained.`);
          await this.persist();
          throw new Error(set.errors.at(-1));
        }
      });
    });
  }

  async write(input: string, content: string, expectedHash?: string | null): Promise<{ path: string; kind: ChangeKind; bytes: number }> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes("\0")) throw new Error("Managed writes are limited to 2 MiB text files.");
    return this.exclusive(async () => {
      const set = this.current();
      const before = await this.readRelative(input, true);
      if (expectedHash !== undefined && before.hash !== expectedHash) throw new Error(`File changed while the edit was being prepared: ${before.path}`);
      const existing = set.files.find((item) => item.path === before.path);
      if (existing && (before.hash !== existing.afterHash || (existing.attribution === "managed" && !this.matchesInstalled(existing, before)))) throw new Error(`External edits overlap the active change in ${before.path}. The write was blocked.`);
      this.assertRequestBaseline(set, before, existing);
      const afterHash = sha256(content);
      if (before.hash === afterHash) return { path: before.path, kind: existing?.kind ?? "modify", bytes: Buffer.byteLength(content) };
      const previousRecord = existing ? structuredClone(existing) : undefined;
      const record: FileRecord = existing ?? {
        path: before.path, kind: before.content === null ? "create" : "modify", beforeContent: before.content,
        afterContent: content, beforeHash: before.hash, afterHash, mode: before.mode, beforeMetadata: before.metadata, attribution: "managed", pending: true,
      };
      const restoreRecord = () => {
        if (existing && previousRecord) Object.assign(existing, previousRecord);
        else { const index = set.files.indexOf(record); if (index >= 0) set.files.splice(index, 1); }
      };
      record.afterContent = content; record.afterHash = afterHash; record.pending = true;
      record.kind = record.beforeContent === null ? "create" : "modify";
      if (!existing) set.files.push(record);
      if (this.setSize(set) > MAX_SET_BYTES) { restoreRecord(); throw new Error("This request exceeds the 10 MiB checkpoint limit. No write was made."); }
      set.updatedAt = new Date().toISOString();
      try { await this.persist(); }
      catch (error) { restoreRecord(); this.store.blockedReason = "checkpoint persistence failed"; throw new Error(`Checkpoint failed; no write was made: ${error instanceof Error ? error.message : String(error)}`); }
      const revalidated = await this.readRelative(before.path, true);
      if (revalidated.hash !== before.hash) { restoreRecord(); await this.persist(); throw new Error(`File changed before the write could be applied: ${before.path}`); }
      try { record.installedMetadata = await this.mutate(set, before.path, before.hash, content, before.metadata, before.identity); }
      catch (error) {
        if (error instanceof MutationNotStartedError) { restoreRecord(); await this.persist(); }
        throw error;
      }
      record.pending = false;
      try { await this.persist(); }
      catch (error) { this.store.blockedReason = "checkpoint finalization failed after a write"; throw new Error(`The file changed, but checkpoint finalization failed. Further writes are blocked: ${error instanceof Error ? error.message : String(error)}`); }
      return { path: before.path, kind: record.kind, bytes: Buffer.byteLength(content) };
    });
  }

  async edit(input: string, oldText: string, newText: string): Promise<{ path: string; kind: ChangeKind; bytes: number }> {
    if (!oldText) throw new Error("Edit oldText must not be empty.");
    const current = await this.readRelative(input, false);
    const first = current.content!.indexOf(oldText);
    if (first < 0 || current.content!.indexOf(oldText, first + oldText.length) >= 0) throw new Error("oldText must match exactly one region in the current file.");
    return this.write(input, `${current.content!.slice(0, first)}${newText}${current.content!.slice(first + oldText.length)}`, current.hash);
  }

  async delete(input: string): Promise<{ path: string; kind: "delete" }> {
    return this.exclusive(async () => {
      const set = this.current(); const before = await this.readRelative(input, false);
      const existing = set.files.find((item) => item.path === before.path);
      if (existing && (before.hash !== existing.afterHash || (existing.attribution === "managed" && !this.matchesInstalled(existing, before)))) throw new Error(`External edits overlap the active change in ${before.path}. The delete was blocked.`);
      this.assertRequestBaseline(set, before, existing);
      const previousRecord = existing ? structuredClone(existing) : undefined;
      const record: FileRecord = existing ?? { path: before.path, kind: "delete", beforeContent: before.content, afterContent: null, beforeHash: before.hash, afterHash: null, mode: before.mode, beforeMetadata: before.metadata, attribution: "managed", pending: true };
      const restoreRecord = () => {
        if (existing && previousRecord) Object.assign(existing, previousRecord);
        else { const index = set.files.indexOf(record); if (index >= 0) set.files.splice(index, 1); }
      };
      record.kind = record.beforeContent === null ? "create" : "delete"; record.afterContent = null; record.afterHash = null; record.pending = true;
      if (!existing) set.files.push(record);
      if (this.setSize(set) > MAX_SET_BYTES) { restoreRecord(); throw new Error("This request exceeds the 10 MiB checkpoint limit. No delete was made."); }
      try { await this.persist(); }
      catch (error) { restoreRecord(); this.store.blockedReason = "checkpoint persistence failed"; throw new Error(`Checkpoint failed; no delete was made: ${error instanceof Error ? error.message : String(error)}`); }
      const revalidated = await this.readRelative(before.path, false);
      if (revalidated.hash !== before.hash) { restoreRecord(); await this.persist(); throw new Error(`File changed before deletion: ${before.path}`); }
      try { record.installedMetadata = await this.mutate(set, before.path, before.hash, null, before.metadata, before.identity); }
      catch (error) {
        if (error instanceof MutationNotStartedError) { restoreRecord(); await this.persist(); }
        throw error;
      }
      record.pending = false; await this.persist();
      return { path: before.path, kind: "delete" };
    });
  }

  private async scanWorkspace(): Promise<Map<string, string>> {
    const result = new Map<string, string>(); let files = 0; let bytes = 0;
    const walk = async (directory: string, relative: string): Promise<void> => {
      if (files >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) return;
      // Pin every parent too: O_NOFOLLOW on the leaf alone cannot stop a
      // directory replaced with a symlink between readdir and open.
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const descriptor = `/proc/self/fd/${parent.fd}`;
        if (!inside(this.root, await realpath(descriptor))) throw new Error("Scan directory escapes the open project.");
        const entries = (await readdir(descriptor, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (files >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) break;
          if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".mauxi-recovery-") || entry.isSymbolicLink()) continue;
          const target = path.join(descriptor, entry.name);
          const name = path.join(relative, entry.name);
          if (entry.isDirectory()) { await walk(target, name); continue; }
          if (!entry.isFile()) continue;
          files++;
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const info = await file.stat();
            if (!info.isFile()) throw new Error(`Scan target is no longer a regular file: ${displayPath(name)}`);
            const remaining = MAX_SCAN_BYTES - bytes;
            if (info.size > MAX_FILE_BYTES || info.size > remaining) { bytes += info.size; continue; }
            // Read until EOF (short reads are legal), never beyond either budget.
            // The extra per-file byte detects growth even if fstat was stale.
            const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1, remaining));
            let length = 0;
            while (length < buffer.length) {
              const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
              if (!bytesRead) break;
              length += bytesRead;
            }
            bytes += Math.max(info.size, length);
            const after = await file.stat();
            if (length > MAX_FILE_BYTES || length !== info.size || fileIdentity(after) !== fileIdentity(info) || after.ctimeMs !== info.ctimeMs) {
              throw new Error(`File changed during bounded workspace scan: ${displayPath(name)}`);
            }
            result.set(displayPath(name), sha256(buffer.subarray(0, length)));
          } finally { await file.close(); }
        }
      } finally { await parent.close(); }
    };
    await walk(this.root, "");
    if (files >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) result.set("<coverage-limit>", `${files}:${bytes}`);
    return result;
  }

  async checkpointCommand(coveredPaths: string[]): Promise<CommandCheckpoint> {
    return this.exclusive(async () => {
      const set = this.current();
      const unique = [...new Set(coveredPaths)];
      if (unique.length > 50) throw new Error("Commands may declare at most 50 checkpoint-covered paths.");
      const previousFiles = structuredClone(set.files);
      const previousWarnings = [...set.coverageWarnings];
      const workspace = await this.scanWorkspace();
      const covered: FileSnapshot[] = [];
      for (const item of unique) covered.push(await this.readRelative(item, true));
      for (const before of covered) {
        const existing = set.files.find((item) => item.path === before.path);
        if (existing && (existing.pending || before.hash !== existing.afterHash)) throw new Error(`External edits overlap the active change in ${before.path}. The command was blocked.`);
      }
      for (const before of covered) {
        const existing = set.files.find((item) => item.path === before.path);
        if (existing) { existing.pending = true; existing.commandPending = true; existing.nonUndoable = true; existing.attribution = "command"; }
        else set.files.push({ path: before.path, kind: before.content === null ? "create" : "modify", beforeContent: before.content, afterContent: before.content, beforeHash: before.hash, afterHash: before.hash, mode: before.mode, attribution: "command", pending: true, commandPending: true, nonUndoable: true });
      }
      set.coverageWarnings.push("Commands can affect caches, databases, remote APIs, generated files, and activity outside the project; those effects are not fully undoable.");
      if (covered.length) set.coverageWarnings.push("Covered files are observations only: concurrent external edits cannot be distinguished from command output. This change set is not eligible for automatic undo.");
      if (this.setSize(set) > MAX_SET_BYTES) { set.files = previousFiles; set.coverageWarnings = previousWarnings; throw new Error("Command coverage exceeds the 10 MiB checkpoint limit."); }
      try { await this.persist(); }
      catch (error) {
        set.files = previousFiles; set.coverageWarnings = previousWarnings; this.store.blockedReason = "command checkpoint persistence failed";
        throw new Error(`Command checkpoint failed; the command was not started: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { changeSetId: set.id, covered, workspace };
    });
  }

  private async observeCommandFile(set: StoredChangeSet, record: FileRecord): Promise<void> {
    record.nonUndoable = true; record.attribution = "command";
    record.pending = false; record.commandPending = false;
    delete record.reviewWarning;
    try {
      const after = await this.readRelative(record.path, true);
      const available = MAX_SET_BYTES - this.setSize(set) + Buffer.byteLength(record.afterContent ?? "");
      record.afterHash = after.hash;
      record.kind = record.beforeContent === null ? "create" : after.content === null ? "delete" : "modify";
      if (Buffer.byteLength(after.content ?? "") <= available) record.afterContent = after.content;
      else {
        record.afterContent = null;
        record.reviewWarning = "After content omitted: aggregate 10 MiB checkpoint limit. Current result is not automatically undoable.";
      }
    } catch (error) {
      record.afterContent = null; record.afterHash = "unavailable";
      record.reviewWarning = `After content unavailable (bounded text coverage only): ${error instanceof Error ? error.message : String(error)}. Not automatically undoable.`;
    }
    if (record.reviewWarning) set.coverageWarnings.push(`${record.path}: ${record.reviewWarning}`);
  }

  async finishCommand(checkpoint: CommandCheckpoint, commandError?: string): Promise<void> {
    await this.exclusive(async () => {
      const set = this.store.changeSets.find((item) => item.id === checkpoint.changeSetId);
      if (!set) throw new Error("Command checkpoint disappeared.");
      for (const before of checkpoint.covered) {
        const record = set.files.find((item) => item.path === before.path)!;
        await this.observeCommandFile(set, record);
      }
      const current = await this.scanWorkspace().catch((error) => {
        set.coverageWarnings.push(`Command workspace comparison is incomplete: ${error instanceof Error ? error.message : String(error)}`);
        return checkpoint.workspace;
      });
      const covered = new Set(checkpoint.covered.map((item) => item.path));
      const changed = new Set([...checkpoint.workspace.keys(), ...current.keys()]);
      set.unexpectedPaths.push(...[...changed].filter((item) => item !== "<coverage-limit>" && !covered.has(item) && checkpoint.workspace.get(item) !== current.get(item)));
      set.unexpectedPaths = [...new Set(set.unexpectedPaths)].slice(0, 500);
      if (checkpoint.workspace.has("<coverage-limit>") || current.has("<coverage-limit>")) set.coverageWarnings.push("Project scanning reached its 2,000-file or 20 MiB coverage limit; some command changes may be unattributable.");
      if (commandError) set.errors.push(commandError.slice(0, 1_000));
      set.updatedAt = new Date().toISOString(); await this.persist();
    });
  }

  private matchesInstalled(file: FileRecord, current: FileSnapshot): boolean {
    if (current.hash !== file.afterHash || file.installedMetadata === undefined) return false;
    return file.installedMetadata === null ? current.hash === null : current.metadata?.changeIdentity === file.installedMetadata.changeIdentity;
  }

  async undo(changeSetId: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      if (this.store.activeId) throw new Error("Wait for the current request to finish before undoing.");
      const set = [...this.store.changeSets].reverse().find((item) => this.undoEligible(item));
      if (!set || set.id !== changeSetId) throw new Error("The displayed change set is no longer the latest eligible change set for undo.");
      const conflicts: string[] = [];
      for (const file of set.files) {
        if (file.beforeHash === file.afterHash) continue;
        const current = await this.readRelative(file.path, true).catch(() => undefined);
        if (!current || !this.matchesInstalled(file, current)) conflicts.push(`${file.path} no longer matches the recorded agent result`);
      }
      if (conflicts.length) {
        set.state = "conflicted"; set.errors.push(...conflicts); set.updatedAt = new Date().toISOString(); await this.persist();
        throw new Error(`Undo stopped safely: ${conflicts.join("; ")}`);
      }
      const previousState = set.state;
      set.state = "undoing"; await this.persist();
      let restored = 0;
      for (const file of [...set.files].reverse()) {
        if (file.beforeHash === file.afterHash) continue;
        const current = await this.readRelative(file.path, true).catch(() => undefined);
        if (!current || !this.matchesInstalled(file, current)) {
          const conflict = `${file.path} changed while undo was being applied${restored ? ` after ${restored} file${restored === 1 ? "" : "s"} had already been restored` : ""}`;
          set.state = "conflicted"; set.errors.push(conflict); set.updatedAt = new Date().toISOString(); await this.persist();
          throw new Error(`Undo stopped safely: ${conflict}`);
        }
        try {
          const restoredMetadata = await this.mutate(set, file.path, file.afterHash, file.beforeContent, file.beforeMetadata, current.identity, current.metadata, true);
          // Our own undo creates a new inode. Transfer only an exactly known
          // predecessor's identity, never infer ownership from matching text.
          for (const predecessor of this.store.changeSets) {
            if (predecessor === set || !["settled", "failed"].includes(predecessor.state)) continue;
            for (const previous of predecessor.files) {
              if (previous.path === file.path && previous.attribution === "managed" && !previous.pending
                && previous.afterHash === file.beforeHash && previous.installedMetadata
                && previous.installedMetadata.changeIdentity === file.beforeMetadata?.changeIdentity) previous.installedMetadata = restoredMetadata;
            }
          }
        } catch (error) {
          set.state = error instanceof MutationNotStartedError && restored === 0 ? previousState : "conflicted";
          const message = `Undo stopped after restoring ${restored} file${restored === 1 ? "" : "s"}: ${error instanceof Error ? error.message : String(error)}`;
          set.errors.push(message);
          set.updatedAt = new Date().toISOString(); await this.persist();
          throw new Error(message);
        }
        restored++;
      }
      set.state = "undone"; set.updatedAt = new Date().toISOString(); await this.persist();
      return { id: set.id };
    });
  }

  views(): AgentChangeSetView[] {
    return this.store.changeSets.slice().reverse().map((set) => ({
      id: set.id, label: set.label, state: set.state, createdAt: set.createdAt, undoEligible: this.undoEligible(set),
      files: set.files.filter((file) => file.beforeHash !== file.afterHash).map((file): AgentChangeFileView => ({
        path: file.path, kind: file.kind, attribution: file.attribution === "command" ? "unattributed" : "managed", diff: file.reviewWarning ?? changeDiff(file.beforeContent, file.afterContent),
      })),
      unexpectedPaths: [...set.unexpectedPaths], coverageWarnings: [...new Set(set.coverageWarnings)], errors: [...set.errors],
    }));
  }

  get hasActive(): boolean { return !!this.store.activeId; }
}
