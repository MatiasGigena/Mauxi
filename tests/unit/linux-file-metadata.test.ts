import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLinuxMetadata, inspectLinuxPath } from "../../src/infrastructure/agent/linux-file-metadata";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mauxi-metadata-")); temporary.push(directory);
  const target = path.join(directory, "target"); await writeFile(target, "content");
  return { directory, target };
}

describe("trusted Linux metadata helper", () => {
  it("ignores project Python modules and environment import hooks", async () => {
    const { directory, target } = await fixture();
    for (const name of ["sitecustomize.py", "os.py", "json.py", "fcntl.py"]) await writeFile(path.join(directory, name), "raise RuntimeError('unapproved project code ran')");
    const previous = process.env.PYTHONPATH; process.env.PYTHONPATH = directory;
    try {
      const result = await inspectLinuxPath(target);
      expect(result.uid).toBe(process.geteuid!());
      expect(result.changeIdentity).toMatch(/^\d+(?::\d+){7}$/);
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous;
    }
  });

  it("verifies requested ownership rather than accepting chown's no-change sentinel", async () => {
    const { target } = await fixture(); const file = await open(target, "r");
    try {
      const metadata = await inspectLinuxMetadata(file);
      await expect(inspectLinuxMetadata(file, { mode: metadata.mode, uid: -1, gid: metadata.gid })).rejects.toThrow(/Exact metadata preservation/);
      expect(await readFile(target, "utf8")).toBe("content");
    } finally { await file.close(); }
  });

  it.skipIf(process.geteuid?.() === 0)("refuses ownership it cannot reproduce without privilege", async () => {
    const { target } = await fixture(); const file = await open(target, "r");
    try {
      const metadata = await inspectLinuxMetadata(file);
      await expect(inspectLinuxMetadata(file, { mode: metadata.mode, uid: metadata.uid + 1, gid: metadata.gid })).rejects.toThrow(/Operation not permitted/);
      expect((await file.stat()).uid).toBe(metadata.uid);
    } finally { await file.close(); }
  });
});
