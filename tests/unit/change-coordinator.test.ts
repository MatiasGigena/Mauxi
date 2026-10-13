import { chmod, mkdtemp, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeCoordinator, changeDiff, RECOVERY_VAULT_LIMITS } from "../../src/infrastructure/agent/change-coordinator";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  beforeLink: undefined as undefined | ((from: string, to: string) => Promise<void>),
  beforeWriteFile: undefined as undefined | ((file: string) => Promise<void>),
  differentDevice: false,
  beforeOpen: undefined as undefined | ((target: string) => Promise<void>),
  afterOpen: undefined as undefined | ((target: string, file: FileHandle) => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const file = await fs.open(...args);
      hooks.afterOpen?.(String(args[0]), file);
      return file;
    },
    rename: async (from: string, to: string) => { await hooks.beforeRename?.(from, to); await fs.rename(from, to); await hooks.afterRename?.(from, to); },
    link: async (from: string, to: string) => { await hooks.beforeLink?.(from, to); await fs.link(from, to); },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => { await hooks.beforeWriteFile?.(String(args[0])); return fs.writeFile(...args); },
    stat: async (target: string) => {
      const info = await fs.stat(target);
      if (hooks.differentDevice && path.basename(await fs.realpath(target)) === "recovery") Object.defineProperty(info, "dev", { value: info.dev + 1 });
      return info;
    },
  };
});
vi.mock("../../src/infrastructure/agent/linux-file-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infrastructure/agent/linux-file-metadata")>();
  return { ...actual, exchangeLinuxFiles: async (from: string, to: string) => {
    await hooks.beforeRename?.(from, to);
    await actual.exchangeLinuxFiles(from, to);
    await hooks.afterRename?.(from, to);
  } };
});
const temporary: string[] = [];
afterEach(async () => {
  hooks.beforeRename = hooks.afterRename = hooks.beforeLink = hooks.beforeWriteFile = undefined;
  hooks.differentDevice = false;
  hooks.beforeOpen = hooks.afterOpen = undefined;
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-changes-")); temporary.push(directory);
  const root = path.join(directory, "project"); const state = path.join(directory, "state");
  await mkdir(path.join(root, "src"), { recursive: true });
  const changes = await ChangeCoordinator.create("workspace-one", root, state);
  const begin = async () => { const id = await changes.prepare("Polish the card"); await changes.activate(id); return id; };
  return { root, state, changes, begin };
}

async function recoveries(state: string): Promise<string[]> {
  return (await readdir(path.join(state, "recovery"))).map((entry) => path.join(state, "recovery", entry));
}

describe("managed change checkpoints", () => {
  it.each(["write", "edit", "delete", "command"])("queues %s behind an unawaited checkpoint activation", async (operation) => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before");
    const first = await begin();
    const next = await changes.prepare("Queued follow-up");
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scanning = new Promise<void>((resolve) => { entered = resolve; });
    hooks.beforeOpen = async (target) => {
      if (!target.endsWith("/a.txt")) return;
      hooks.beforeOpen = undefined; entered(); await gate;
    };
    const activation = changes.switchToPrepared(next); // deliberately not awaited
    await scanning;
    const mutation = operation === "write" ? changes.write("src/a.txt", "after")
      : operation === "edit" ? changes.edit("src/a.txt", "before", "after")
      : operation === "delete" ? changes.delete("src/a.txt")
      : changes.checkpointCommand(["src/a.txt"]);
    expect(changes.views().find((set) => set.id === next)?.state).toBe("prepared");
    release();
    const [, result] = await Promise.all([activation, mutation]);
    expect(changes.views().find((set) => set.id === first)?.files).toEqual([]);
    if ("changeSetId" in result) expect(result.changeSetId).toBe(next);
    else expect(changes.views().find((set) => set.id === next)?.files.map((file) => file.path)).toEqual(["src/a.txt"]);
  });

  it("retires failed queued activations, blocks their tools, and preserves request capacity", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before");
    const first = await begin();
    for (let i = 0; i < 9; i++) {
      const next = await changes.prepare(`Follow-up ${i}`);
      hooks.beforeOpen = async (target) => {
        if (target.endsWith("/a.txt")) { hooks.beforeOpen = undefined; throw new Error("Concurrent scan failure"); }
      };
      const results = await Promise.allSettled([changes.switchToPrepared(next), changes.write("src/a.txt", "wrong request")]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(changes.views().find((set) => set.id === next)).toMatchObject({ state: "failed", errors: [expect.stringContaining("Concurrent scan failure")] });
      await changes.settle();
    }
    expect(changes.views().find((set) => set.id === first)?.files).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("before");
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views().filter((set) => set.state === "failed")).toHaveLength(9);
    await begin();
    await changes.write("src/a.txt", "new request");
  });

  it("keeps a conflicted request conflicted when a queued follow-up activates", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before");
    const first = await begin();
    hooks.beforeLink = async (from) => {
      if (from.endsWith("/replacement")) { hooks.beforeLink = undefined; await writeFile(file, "external arrival"); }
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/stopped safely/);
    expect(changes.views().find((set) => set.id === first)?.state).toBe("conflicted");
    const next = await changes.prepare("Queued follow-up");
    await changes.switchToPrepared(next);
    expect(changes.views().find((set) => set.id === first)?.state).toBe("conflicted");
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views().find((set) => set.id === first)?.state).toBe("conflicted");
  });

  it("blocks tools when queued activation persistence fails", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin();
    const next = await changes.prepare("Queued follow-up");
    hooks.beforeRename = async (_from, to) => {
      if (to.startsWith(state) && to.endsWith(".json")) { hooks.beforeRename = undefined; throw new Error("Persistence failed"); }
    };
    const results = await Promise.allSettled([changes.switchToPrepared(next), changes.write("src/a.txt", "bad")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views().find((set) => set.id === next)?.state).toBe("failed");
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("before");
  });

  it.each(["file", "directory"])("rejects a %s swapped to a symlink during a scan", async (kind) => {
    const { root, changes, begin } = await setup();
    const source = path.join(root, "src/a.txt"); await writeFile(source, "inside");
    const outside = path.join(path.dirname(root), "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "a.txt"), "outside");
    hooks.beforeOpen = async (target) => {
      if (!target.endsWith(kind === "file" ? "/a.txt" : "/src")) return;
      hooks.beforeOpen = undefined;
      const original = kind === "file" ? source : path.dirname(source);
      await rename(original, `${original}-saved`);
      await symlink(kind === "file" ? path.join(outside, "a.txt") : outside, original);
    };
    await expect(begin()).rejects.toThrow(/ELOOP|ENOTDIR/);
    expect(changes.views()[0].state).toBe("prepared");
  });

  it.each([false, true])("bounds descriptor reads when a file grows after fstat (aggregate edge: %s)", async (aggregateEdge) => {
    const { root, begin } = await setup();
    const maxFile = 2 * 1024 * 1024; const maxScan = 20 * 1024 * 1024;
    let earlierBytes = 0;
    if (aggregateEdge) {
      for (let i = 0; i < 10; i++) {
        const size = i === 9 ? maxFile - 32 : maxFile;
        await writeFile(path.join(root, `a-${i}.txt`), Buffer.alloc(size, 120));
        earlierBytes += size;
      }
    }
    const target = path.join(root, "z-grow.txt"); await writeFile(target, "small");
    let requested = 0;
    hooks.afterOpen = (name, file) => {
      if (!name.endsWith("/z-grow.txt")) return;
      const originalStat = file.stat.bind(file);
      vi.spyOn(file, "stat").mockImplementationOnce(async () => {
        const info = await originalStat();
        await truncate(target, maxScan * 2);
        return info;
      });
      const originalRead = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(async (...args: unknown[]) => {
        requested += args[2] as number;
        return Reflect.apply(originalRead, file, args);
      });
    };
    await expect(begin()).rejects.toThrow(/changed during bounded workspace scan/);
    expect(requested).toBeLessThanOrEqual(Math.min(maxFile + 1, maxScan - earlierBytes));
    expect(requested).toBeGreaterThan(0);
  });

  it.each(["replace", "chmod", "chmod-back"])("conflicts on same-content external %s before undo, including after restart", async (operation) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); const id = await begin();
    await changes.write("src/a.txt", "agent"); await changes.settle();
    const mode = (await stat(file)).mode;
    if (operation === "replace") {
      const other = path.join(root, "src/other.txt"); await writeFile(other, "agent"); await chmod(other, mode); await rename(other, file);
    } else {
      await chmod(file, (mode & 0o7777) ^ 0o100);
      if (operation === "chmod-back") await chmod(file, mode);
    }
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    await expect(recovered.undo(id)).rejects.toThrow(/stopped safely/);
    expect(await readFile(file, "utf8")).toBe("agent");
  });

  it("preserves exact ownership and mode despite restrictive umask, including delete undo", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await chmod(file, 0o6754);
    const original = await stat(file); const mask = process.umask(0o077);
    try {
      const id = await begin(); await changes.write("src/a.txt", "agent"); await changes.settle();
      expect(await stat(file)).toMatchObject({ mode: original.mode, uid: original.uid, gid: original.gid });
      await changes.undo(id);
      expect(await stat(file)).toMatchObject({ mode: original.mode, uid: original.uid, gid: original.gid, mtimeMs: original.mtimeMs });
      const deletion = await begin(); await changes.delete("src/a.txt"); await changes.settle(); await changes.undo(deletion);
      expect(await stat(file)).toMatchObject({ mode: original.mode, uid: original.uid, gid: original.gid, mtimeMs: original.mtimeMs });
    } finally { process.umask(mask); }
  });

  it("keeps a proven earlier result undoable after managed undo recreates its inode", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "original");
    const first = await begin(); await changes.write("src/a.txt", "first"); await changes.settle();
    const second = await begin(); await changes.write("src/a.txt", "second"); await changes.settle();
    await changes.undo(second);
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    await recovered.undo(first);
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("gives new files ordinary target-directory umask and setgid creation semantics", async () => {
    const { root, changes, begin } = await setup();
    const parent = path.join(root, "src"); await chmod(parent, 0o2775);
    const mask = process.umask(0o027);
    try {
      await writeFile(path.join(parent, "reference.txt"), "reference");
      const reference = await stat(path.join(parent, "reference.txt"));
      const id = await begin(); await changes.write("src/new.txt", "agent"); await changes.settle();
      expect(await stat(path.join(parent, "new.txt"))).toMatchObject({ mode: reference.mode, uid: reference.uid, gid: reference.gid });
      await changes.undo(id); await expect(stat(path.join(parent, "new.txt"))).rejects.toThrow();
    } finally { process.umask(mask); }
  });

  it.each(["file-xattr", "parent-xattr", "default-acl", "access-acl", "flags"])("refuses unsupported visible metadata before displacement (%s)", async (kind) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    const target = kind === "parent-xattr" || kind === "default-acl" ? path.dirname(file) : file;
    const script = kind === "flags" ? "import os,sys,fcntl,array; f=os.open(sys.argv[1],os.O_RDONLY); a=array.array('L',[0]); fcntl.ioctl(f,0x80086601,a,True); a[0]|=0x40; fcntl.ioctl(f,0x40086602,a,True)" : kind.endsWith("acl")
      ? "import os,sys,struct; entries=[(1,7,0xffffffff),(4,5,0xffffffff),(32,0,0xffffffff)]; entries=entries if sys.argv[2]=='default-acl' else [entries[0],(2,4,os.getuid()+1),entries[1],(16,5,0xffffffff),entries[2]]; os.setxattr(sys.argv[1], 'system.posix_acl_default' if sys.argv[2]=='default-acl' else 'system.posix_acl_access',struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in entries))"
      : "import os,sys; os.setxattr(sys.argv[1],'user.mauxi-test',b'preserve me')";
    await promisify(execFile)("/usr/bin/python3", ["-I", "-S", "-c", script, target, kind]);
    const before = await stat(file);
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/metadata|flags/);
    await expect(changes.delete("src/a.txt")).rejects.toThrow(/metadata|flags/);
    if (target !== file) await expect(changes.write("src/new.txt", "agent")).rejects.toThrow(/metadata/);
    expect(await readFile(file, "utf8")).toBe("before");
    expect((await stat(file)).ino).toBe(before.ino);
    expect(changes.views()[0].files).toEqual([]);
    expect(await readdir(state)).not.toContain("recovery");
  });

  it("refuses undo when caller-visible metadata is added to the result", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); const id = await begin();
    await changes.write("src/a.txt", "agent"); await changes.settle();
    await promisify(execFile)("/usr/bin/python3", ["-I", "-S", "-c", "import os,sys; os.setxattr(sys.argv[1],'user.external',b'data')", file]);
    await expect(changes.undo(id)).rejects.toThrow(/stopped safely/);
    expect(await readFile(file, "utf8")).toBe("agent");
  });

  it.each([false, true])("never upgrades hash-only legacy/interrupted results to undoable identities (pending: %s)", async (pending) => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin(); await changes.write("src/a.txt", "agent"); await changes.settle();
    const storePath = path.join(state, (await readdir(state)).find((name) => name.endsWith(".json"))!);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    delete stored.changeSets[0].files[0].installedMetadata; stored.changeSets[0].files[0].pending = pending;
    await writeFile(storePath, JSON.stringify(stored));
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views()[0].undoEligible).toBe(false);
    expect(recovered.views()[0].coverageWarnings.join(" ")).toContain("no automatic undo");
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("agent");
  });

  it("strictly bounds 2 MiB single-line diffs and serialized review snapshots", async () => {
    const large = "x".repeat(2 * 1024 * 1024);
    for (const [before, after] of [[null, large], [large, null], [large, `${large.slice(1)}y`], ["é".repeat(50_000), "界".repeat(50_000)]]) {
      expect(Buffer.byteLength(changeDiff(before, after))).toBeLessThanOrEqual(120_000);
      expect(changeDiff(before, after)).toContain("too large");
    }
    const { changes, begin } = await setup(); await begin();
    for (let i = 0; i < 5; i++) await changes.write(`src/large-${i}.txt`, large);
    expect(Buffer.byteLength(JSON.stringify(changes.views()))).toBeLessThan(10_000);
    expect(changes.views()[0].files).toHaveLength(5);
  });

  it("uses the actual dirty baseline, presents its own diff, and restores only the agent edit", async () => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/Card.tsx"), "// user work\nexport const Card = () => <p>Old</p>;\n"); const changeSetId = await begin();
    await changes.edit("src/Card.tsx", "<p>Old</p>", "<p className=\"polished\">New</p>");
    await changes.settle();
    const view = changes.views()[0];
    expect(view.files).toHaveLength(1);
    expect(view.files[0].diff).toContain("-export const Card = () => <p>Old</p>;");
    expect(view.files[0].diff).toContain("+export const Card = () => <p className=\"polished\">New</p>;");
    await changes.undo(changeSetId);
    expect(await readFile(path.join(root, "src/Card.tsx"), "utf8")).toBe("// user work\nexport const Card = () => <p>Old</p>;\n");
  });

  it("serializes parallel edits and rejects the stale one instead of overwriting it", async () => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "one\n"); await begin();
    const results = await Promise.allSettled([
      changes.edit("src/a.txt", "one", "first"),
      changes.edit("src/a.txt", "one", "second"),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(["first\n", "second\n"]).toContain(await readFile(path.join(root, "src/a.txt"), "utf8"));
  });

  it("blocks escaping, protected, and symlink writes", async () => {
    const { root, changes, begin } = await setup();
    const outside = path.join(path.dirname(root), "outside.txt"); await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "src/link.txt"));
    const outsideDirectory = path.join(path.dirname(root), "outside-directory"); await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(root, "linked-directory")); await begin();
    await expect(changes.write("../outside.txt", "bad")).rejects.toThrow(/escape|relative/i);
    await expect(changes.write(".git/config", "bad")).rejects.toThrow(/protected/i);
    await expect(changes.write(".env.local", "bad")).rejects.toThrow(/protected/i);
    await expect(changes.write("src/link.txt", "bad")).rejects.toThrow(/symbolic/i);
    await expect(changes.write("linked-directory/escaped.txt", "bad")).rejects.toThrow(/symbolic|escape/i);
    expect(await readFile(outside, "utf8")).toBe("secret");
    await expect(readFile(path.join(outsideDirectory, "escaped.txt"), "utf8")).rejects.toThrow();
  });

  it("does not absorb an external edit made after the request baseline", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "baseline\n"); await begin();
    await writeFile(file, "user changed this while the agent worked\n");
    await expect(changes.write("src/a.txt", "agent overwrite\n")).rejects.toThrow(/after this request checkpoint/i);
    expect(await readFile(file, "utf8")).toContain("user changed");
  });

  it("fails closed for paths omitted by an incomplete bounded baseline", async () => {
    const { root, changes, begin } = await setup();
    const largeGenerated = path.join(root, "000-large-generated.bin"); await writeFile(largeGenerated, ""); await truncate(largeGenerated, 21 * 1024 * 1024);
    await writeFile(path.join(root, "src/a.txt"), "baseline\n"); await begin();
    await expect(changes.write("src/a.txt", "overwrite\n")).rejects.toThrow(/outside this request's bounded baseline/i);
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("baseline\n");
  });

  it("restores an existing record when a resized write exceeds the set limit", async () => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/target.txt"), "a"); await begin();
    await changes.write("src/target.txt", "b");
    const large = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 4; index++) await changes.write(`src/large-${index}.txt`, large);
    await expect(changes.write("src/target.txt", large)).rejects.toThrow(/10 MiB/i);
    expect(await readFile(path.join(root, "src/target.txt"), "utf8")).toBe("b");
    await changes.write("src/target.txt", "c");
    expect(await readFile(path.join(root, "src/target.txt"), "utf8")).toBe("c");
  });

  it("enforces the set size limit before deleting additional files", async () => {
    const { root, changes, begin } = await setup();
    const large = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 6; index++) await writeFile(path.join(root, `src/delete-${index}.txt`), large);
    await begin();
    for (let index = 0; index < 5; index++) await changes.delete(`src/delete-${index}.txt`);
    await expect(changes.delete("src/delete-5.txt")).rejects.toThrow(/10 MiB/i);
    expect((await readFile(path.join(root, "src/delete-5.txt"))).byteLength).toBe(2 * 1024 * 1024);
  });

  it("refuses undo after an overlapping external edit and preserves current content", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before\n"); const changeSetId = await begin();
    await changes.write("src/a.txt", "agent\n"); await changes.settle();
    await writeFile(file, "external\n");
    await expect(changes.undo(changeSetId)).rejects.toThrow(/stopped safely/i);
    expect(await readFile(file, "utf8")).toBe("external\n");
    expect(changes.views()[0].state).toBe("conflicted");
  });

  it("blocks a command when a covered managed file was externally edited", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "baseline\n"); await begin();
    await changes.write("src/a.txt", "agent\n");
    await writeFile(file, "external\n");
    await expect(changes.checkpointCommand(["src/a.txt"])).rejects.toThrow(/external edits overlap/i);
    expect(await readFile(file, "utf8")).toBe("external\n");
  });

  it("captures declared command files while identifying undeclared changes honestly", async () => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before\n"); await begin();
    const checkpoint = await changes.checkpointCommand(["src/a.txt"]);
    await writeFile(path.join(root, "src/a.txt"), "after\n");
    await writeFile(path.join(root, "src/unexpected.txt"), "generated\n");
    await changes.finishCommand(checkpoint);
    await changes.settle();
    const view = changes.views()[0];
    expect(view.files[0]).toMatchObject({ path: "src/a.txt", attribution: "unattributed" });
    expect(view.undoEligible).toBe(false);
    expect(view.unexpectedPaths).toContain("src/unexpected.txt");
    expect(view.coverageWarnings.join(" ")).toMatch(/not fully undoable/i);
  });

  it("reports undeclared command changes to files too large to hash", async () => {
    const { root, changes, begin } = await setup();
    const lock = path.join(root, "package-lock.json");
    await writeFile(lock, Buffer.alloc(3 * 1024 * 1024, 120)); await begin();
    const checkpoint = await changes.checkpointCommand([]);
    await writeFile(lock, Buffer.alloc(3 * 1024 * 1024 + 1, 121));
    await changes.finishCommand(checkpoint);
    await changes.settle();
    const view = changes.views()[0];
    expect(view.unexpectedPaths).toContain("package-lock.json");
  });

  it("undoes only the explicitly selected latest eligible change set", async () => {
    const { root, changes, begin } = await setup();
    await writeFile(path.join(root, "src/one.txt"), "one\n"); await writeFile(path.join(root, "src/two.txt"), "two\n");
    const first = await begin(); await changes.write("src/one.txt", "agent one\n"); await changes.settle();
    const second = await changes.prepare("Second change"); await changes.activate(second); await changes.write("src/two.txt", "agent two\n"); await changes.settle();
    await expect(changes.undo(first)).rejects.toThrow(/no longer the latest eligible/i);
    expect(await readFile(path.join(root, "src/one.txt"), "utf8")).toBe("agent one\n");
    await changes.undo(second);
    expect(await readFile(path.join(root, "src/two.txt"), "utf8")).toBe("two\n");
    const empty = await changes.prepare("Failed empty"); await changes.abandonPrepared(empty, "No writes");
    await expect(changes.undo(empty)).rejects.toThrow(/latest eligible/);
    await changes.undo(first);
    expect(await readFile(path.join(root, "src/one.txt"), "utf8")).toBe("one\n");
  });

  it.each([false, true])("never treats concurrent covered command edits as undoable (managed first: %s)", async (managedFirst) => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "baseline"); const id = await begin();
    if (managedFirst) await changes.write("src/a.txt", "managed");
    const checkpoint = await changes.checkpointCommand(["src/a.txt"]);
    await writeFile(file, "command output\nexternal work\n");
    await changes.finishCommand(checkpoint); await changes.settle();
    expect(changes.views()[0]).toMatchObject({ undoEligible: false, files: [{ attribution: "unattributed" }] });
    await expect(changes.undo(id)).rejects.toThrow(/latest eligible/);
    expect(await readFile(file, "utf8")).toContain("external work");
  });

  it.each(["finish", "recover"] as const)("bounds aggregate command results on disk and reports omitted after content (%s)", async (mode) => {
    const { root, state, changes, begin } = await setup(); await begin();
    const paths = Array.from({ length: 6 }, (_, i) => `src/large-${i}.txt`);
    const checkpoint = await changes.checkpointCommand(paths);
    for (const file of paths) await writeFile(path.join(root, file), "x".repeat(2 * 1024 * 1024));
    let observed = changes;
    if (mode === "finish") { await changes.finishCommand(checkpoint); await changes.settle(); }
    else observed = await ChangeCoordinator.create("reopened", root, state);
    const stored = JSON.parse(await readFile(path.join(state, (await readdir(state)).find((name) => name.endsWith(".json"))!), "utf8"));
    const bytes = stored.changeSets[0].files.reduce((total: number, file: { beforeContent: string | null; afterContent: string | null }) => total + Buffer.byteLength(file.beforeContent ?? "") + Buffer.byteLength(file.afterContent ?? ""), 0);
    expect(bytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(observed.views()[0].coverageWarnings.join(" ")).toContain("aggregate 10 MiB");
    expect(observed.views()[0].files).toHaveLength(6);
    expect(observed.views()[0].undoEligible).toBe(false);
  });

  it.each([false, true])("recovers interrupted covered command writes as reviewable partial observations (managed first: %s)", async (managedFirst) => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin();
    if (managedFirst) await changes.write("src/a.txt", "managed before command");
    await changes.checkpointCommand(["src/a.txt", "src/large.txt", "src/binary.txt"]);
    await writeFile(path.join(root, "src/a.txt"), "partial command plus possible external work");
    await writeFile(path.join(root, "src/large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(path.join(root, "src/binary.txt"), "\0binary");
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    const view = recovered.views()[0];
    expect(view).toMatchObject({ state: "failed", undoEligible: false });
    expect(view.files.find((file) => file.path === "src/a.txt")?.diff).toContain("+partial command");
    expect(view.coverageWarnings.join(" ")).toMatch(/Interrupted command/);
    expect(view.coverageWarnings.join(" ")).toMatch(/After content unavailable/);
    await expect(recovered.undo(view.id)).rejects.toThrow(/latest eligible/);
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toContain("external work");
  });

  it.each(["write", "undo", "delete"] as const)("preserves a target edited after final revalidation during %s", async (operation) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); const id = await begin();
    if (operation === "undo") { await changes.write("src/a.txt", "agent"); await changes.settle(); }
    hooks.beforeRename = async (_from, to) => {
      if (to.endsWith("/displaced")) { hooks.beforeRename = undefined; await writeFile(file, "external race"); }
    };
    await expect(operation === "undo" ? changes.undo(id) : operation === "delete" ? changes.delete("src/a.txt") : changes.write("src/a.txt", "agent")).rejects.toThrow(/stopped safely/);
    if (operation === "delete") expect(await readFile(file, "utf8")).toBe("external race");
    else {
      const dirs = await recoveries(state);
      expect(await Promise.all(dirs.map(dir => readFile(path.join(dir, "displaced"), "utf8")))).toContain("external race");
    }
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views()[0].state).toBe("conflicted");
  });

  it("rejects a same-content inode replacement after revalidation", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    hooks.beforeRename = async (_from, to) => {
      if (!to.endsWith("/displaced")) return;
      hooks.beforeRename = undefined;
      const other = path.join(root, "src/other.txt"); await writeFile(other, "before"); await rename(other, file);
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/changed after revalidation/);
    expect(await readFile(path.join((await recoveries(state))[0], "displaced"), "utf8")).toBe("before");
  });

  it.each([false, true])("does not clobber a concurrent arrival at installation (creating: %s)", async (creating) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); if (!creating) await writeFile(file, "before"); await begin();
    hooks.beforeLink = async (from) => {
      if (from.endsWith("/replacement")) { hooks.beforeLink = undefined; await writeFile(file, "external arrival"); }
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/stopped safely/);
    if (creating) expect(await readFile(file, "utf8")).toBe("external arrival");
    const [directory] = await recoveries(state);
    expect(await readFile(path.join(directory, "replacement"), "utf8")).toBe("agent");
    if (!creating) expect(await readFile(path.join(directory, "displaced"), "utf8")).toBe("external arrival");
  });

  it("preserves an external arrival after the atomic exchange", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    hooks.afterRename = async (_from, to) => {
      if (!to.endsWith("/displaced")) return;
      hooks.afterRename = undefined;
      const incoming = path.join(root, "incoming.txt");
      await writeFile(incoming, "external arrival"); await rename(incoming, file);
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/Installed inode/);
    expect(await readFile(file, "utf8")).toBe("external arrival");
    const [directory] = await recoveries(state);
    expect(await readFile(path.join(directory, "displaced"), "utf8")).toBe("before");
    expect(await readFile(path.join(directory, "replacement"), "utf8")).toBe("agent");
  });

  it("does not install staging as a supposed backup when exchange finds a moved target", async () => {
    const { root, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    hooks.beforeRename = async (_from, to) => {
      if (!to.endsWith("/displaced")) return;
      hooks.beforeRename = undefined; await rename(file, `${file}.moved`);
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/Atomic Linux exchange failed/);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${file}.moved`, "utf8")).toBe("before");
  });

  it("preserves a dangling symlink arriving during deletion", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    hooks.afterRename = async (_from, to) => {
      if (to.endsWith("/displaced")) { hooks.afterRename = undefined; await symlink("missing-external-file", file); }
    };
    await expect(changes.delete("src/a.txt")).rejects.toThrow(/arrived during deletion/);
    expect(await readlink(file)).toBe("missing-external-file");
    const [recovery] = await recoveries(state);
    expect(await readFile(path.join(recovery, "displaced"), "utf8")).toBe("before");
  });

  it("retains late writes to a displaced inode rather than silently claiming a safe replacement", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin();
    hooks.afterRename = async (_from, to) => {
      if (to.endsWith("/displaced")) { hooks.afterRename = undefined; await writeFile(to, "late external write"); }
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/changed after revalidation/);
    const [recovery] = await recoveries(state);
    expect(await readFile(path.join(recovery, "displaced"), "utf8")).toBe("late external write");
    expect(changes.views()[0].undoEligible).toBe(false);
  });

  it("recovers a durable displaced file when interrupted before installation/restoration", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin();
    hooks.afterRename = async (_from, to) => { if (to.endsWith("/displaced")) throw new Error("interrupted after displacement"); };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/stopped safely/);
    hooks.afterRename = hooks.beforeLink = undefined;
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views()[0].errors.join(" ")).toContain("Interrupted mutation");
    const [recovery] = await recoveries(state);
    expect(await readFile(path.join(recovery, "displaced"), "utf8")).toBe("before");
    expect(await readFile(path.join(recovery, "replacement"), "utf8")).toBe("agent");
    expect(JSON.parse(await readFile(path.join(recovery, "intent.json"), "utf8"))).toMatchObject({ workspaceRoot: root, path: "src/a.txt" });
  });

  it("keeps all recovery artifacts outside the project across successful writes and undo", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); const id = await begin();
    await changes.write("src/a.txt", "first"); await changes.write("src/a.txt", "second"); await changes.settle();
    await changes.undo(id);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(["src", "src/a.txt"]);
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("before");
    expect(await recoveries(state)).toHaveLength(3);
    for (const directory of await recoveries(state)) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(path.join(directory, "intent.json"), "utf8"))).toMatchObject({ workspaceRoot: root, path: "src/a.txt", changeSetId: id });
    }
  });

  it("rejects checkpoint storage inside the project", async () => {
    const { root } = await setup();
    await expect(ChangeCoordinator.create("bad", root, path.join(root, "state"))).rejects.toThrow(/outside the project/);
    expect((await readdir(root)).sort()).toEqual(["src"]);
  });

  it("rejects storage inside a parent repository when the open workspace is a subdirectory", async () => {
    const { root } = await setup(); await mkdir(path.join(root, ".git"));
    await expect(ChangeCoordinator.create("nested", path.join(root, "src"), path.join(root, "profile"))).rejects.toThrow(/outside the project and its repository/);
    expect((await readdir(root)).sort()).toEqual([".git", "src"]);
  });

  it("refuses the byte budget before mutation, counting orphaned recovery data", async () => {
    const { root, state, changes, begin } = await setup();
    const orphan = path.join(state, "recovery", "orphaned-entry"); await mkdir(orphan, { recursive: true });
    const retained = path.join(orphan, "displaced"); await writeFile(retained, "retained external work"); await truncate(retained, RECOVERY_VAULT_LIMITS.bytes - 1024 * 1024);
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin();
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/Recovery vault limit/);
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("before");
    expect(changes.views()[0].files).toEqual([]);
    expect(await recoveries(state)).toEqual([orphan]);
    expect((await stat(retained)).size).toBe(RECOVERY_VAULT_LIMITS.bytes - 1024 * 1024);
  });

  it("serializes the entry budget across workspaces sharing the same vault", async () => {
    const { root, state, changes, begin } = await setup();
    const vault = path.join(state, "recovery"); await mkdir(vault);
    for (let i = 0; i < RECOVERY_VAULT_LIMITS.entries - 1; i++) await mkdir(path.join(vault, `retained-${i}`));
    const otherRoot = path.join(path.dirname(root), "other-project"); await mkdir(otherRoot);
    const other = await ChangeCoordinator.create("other", otherRoot, state);
    await begin(); const id = await other.prepare("Other request"); await other.activate(id);
    const results = await Promise.allSettled([changes.write("src/a.txt", "one"), other.write("a.txt", "two")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await recoveries(state)).toHaveLength(RECOVERY_VAULT_LIMITS.entries);
    expect(changes.views()[0].files.length + other.views()[0].files.length).toBe(1);
  });

  it.each(["write", "delete", "undo"] as const)("fails closed across filesystems without poisoning retry state (%s)", async (operation) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); const id = await begin();
    if (operation === "undo") { await changes.write("src/a.txt", "agent"); await changes.settle(); }
    hooks.differentDevice = true;
    const apply = () => operation === "undo" ? changes.undo(id) : operation === "delete" ? changes.delete("src/a.txt") : changes.write("src/a.txt", "agent");
    await expect(apply()).rejects.toThrow(/different filesystems.*no in-project fallback/);
    expect(await readFile(file, "utf8")).toBe(operation === "undo" ? "agent" : "before");
    expect(await recoveries(state)).toHaveLength(operation === "undo" ? 1 : 0);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(["src", "src/a.txt"]);
    if (operation === "undo") expect(changes.views()[0]).toMatchObject({ state: "settled", undoEligible: true });
    else expect(changes.views()[0].files).toEqual([]);
    hooks.differentDevice = false;
    await apply();
  });

  it.each(["content", "intent-persistence"] as const)("removes only unexposed staging on failure and allows a safe retry (%s)", async (failure) => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before"); await begin();
    if (failure === "content") hooks.beforeWriteFile = async (target) => { if (target.endsWith("/replacement")) { hooks.beforeWriteFile = undefined; throw new Error("staging failed"); } };
    else hooks.beforeRename = async (from, to) => {
      if (to.endsWith(".json") && JSON.parse(await readFile(from, "utf8")).changeSets[0].recoveries?.length) {
        hooks.beforeRename = undefined; throw new Error("staging failed while persisting intent");
      }
    };
    await expect(changes.write("src/a.txt", "agent")).rejects.toThrow(/staging failed/);
    expect(await recoveries(state)).toEqual([]);
    expect((await readdir(state)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(changes.views()[0].files).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("before");
    await changes.write("src/a.txt", "retry");
    expect(await readFile(file, "utf8")).toBe("retry");
  });

  it("reports partial undo honestly if recovery capacity runs out between files", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before-a"); await writeFile(path.join(root, "src/b.txt"), "before-b");
    const id = await begin(); await changes.write("src/a.txt", "agent-a"); await changes.write("src/b.txt", "agent-b"); await changes.settle();
    const vault = path.join(state, "recovery");
    for (let i = 2; i < RECOVERY_VAULT_LIMITS.entries - 1; i++) await mkdir(path.join(vault, `retained-${i}`));
    await expect(changes.undo(id)).rejects.toThrow(/after restoring 1 file: Recovery vault limit/);
    expect(changes.views()[0]).toMatchObject({ state: "conflicted", undoEligible: false });
    expect(changes.views()[0].errors.join(" ")).toContain("after restoring 1 file");
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("agent-a");
    expect(await readFile(path.join(root, "src/b.txt"), "utf8")).toBe("before-b");
    expect(await recoveries(state)).toHaveLength(RECOVERY_VAULT_LIMITS.entries);
  });

  it("pins recovery-bearing checkpoints until explicit manual cleanup instead of orphaning retained data", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before");
    let first = "";
    for (let i = 0; i < 64; i++) {
      const id = await begin(); if (i === 0) first = id;
      await changes.write("src/a.txt", `change-${i}`); await changes.settle();
    }
    await expect(changes.prepare("Must not prune retained recovery")).rejects.toThrow(/retained recovery/);
    expect(await recoveries(state)).toHaveLength(64);
    expect(changes.views().some((view) => view.id === first)).toBe(true);
    let oldest = "";
    for (const directory of await recoveries(state)) {
      if (JSON.parse(await readFile(path.join(directory, "intent.json"), "utf8")).changeSetId === first) oldest = directory;
    }
    // Simulates the user's reviewed cleanup after all external writers stopped.
    expect(oldest).not.toBe(""); await rm(oldest, { recursive: true });
    await changes.prepare("Room after manual cleanup");
    expect(changes.views().some((view) => view.id === first)).toBe(false);
    expect(await recoveries(state)).toHaveLength(63);
  }, 30_000);

  it("preserves legacy in-project recovery and surfaces its separate manual-cleanup requirement", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before"); await begin(); await changes.write("src/a.txt", "agent"); await changes.settle();
    const [entry] = await recoveries(state);
    const legacyRelative = "src/.mauxi-recovery-legacy";
    await rename(entry, path.join(root, legacyRelative));
    const storePath = path.join(state, (await readdir(state)).find((name) => name.endsWith(".json"))!);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    stored.changeSets[0].recoveries[0].directory = legacyRelative;
    await writeFile(storePath, JSON.stringify(stored));
    const recovered = await ChangeCoordinator.create("reopened", root, state);
    expect(recovered.views()[0].coverageWarnings.join(" ")).toContain("Legacy in-project recovery");
    expect(recovered.views()[0].coverageWarnings.join(" ")).toContain("outside the external vault quota");
    expect(await readFile(path.join(root, legacyRelative, "displaced"), "utf8")).toBe("before");
    expect(await recoveries(state)).toEqual([]);
  });

  it("retains true late-writer updates and refuses new mutations if retained data grows over budget", async () => {
    const { root, state, changes, begin } = await setup();
    const file = path.join(root, "src/a.txt"); await writeFile(file, "before");
    const writer = await open(file, "r+");
    try {
      await begin(); await changes.write("src/a.txt", "agent");
      const [directory] = await recoveries(state);
      await writer.writeFile("external writer after successful mutation"); await writer.sync();
      expect(await readFile(path.join(directory, "displaced"), "utf8")).toBe("external writer after successful mutation");
      await writer.truncate(RECOVERY_VAULT_LIMITS.bytes + 1);
      await expect(changes.write("src/a.txt", "next")).rejects.toThrow(/Recovery vault limit/);
      expect(await readFile(file, "utf8")).toBe("agent");
      expect((await stat(path.join(directory, "displaced"))).size).toBe(RECOVERY_VAULT_LIMITS.bytes + 1);
      expect(await recoveries(state)).toHaveLength(1);
    } finally { await writer.close(); }
  });

  it("prunes completed records so the bounded store does not permanently disable requests", async () => {
    const { changes } = await setup();
    for (let index = 0; index < 70; index++) {
      const id = await changes.prepare(`Read-only request ${index}`); await changes.activate(id); await changes.settle();
    }
    expect(changes.views().length).toBeLessThanOrEqual(64);
    expect(changes.views()[0].label).toBe("Read-only request 69");
  });

  it("recovers interrupted active records by stable project identity", async () => {
    const { root, state, changes, begin } = await setup();
    await writeFile(path.join(root, "src/a.txt"), "before\n"); await begin();
    await changes.write("src/a.txt", "partial\n");
    const recovered = await ChangeCoordinator.create("workspace-after-restart", root, state);
    expect(recovered.views()[0].state).toBe("failed");
    expect(recovered.views()[0].errors.join(" ")).toMatch(/partial changes/i);
    await recovered.undo(recovered.views()[0].id);
    expect(await readFile(path.join(root, "src/a.txt"), "utf8")).toBe("before\n");
  });
});
