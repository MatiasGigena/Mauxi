import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectPickerLocation } from "../../src/infrastructure/project/project-picker-location";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-picker-")); roots.push(root);
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home); await mkdir(project);
  const file = path.join(root, "settings", "project-picker.json");
  return { root, home, project, file, store: new ProjectPickerLocation(file) };
}

describe("project picker location", () => {
  it("defaults to home and remembers a selected folder across instances", async () => {
    const { home, project, file, store } = await fixture();
    expect(await store.defaultPath(home)).toBe(home);
    await store.remember(project);
    expect(await new ProjectPickerLocation(file).defaultPath(home)).toBe(project);
  });

  it("falls back to home for corrupt or invalid preferences", async () => {
    const { home, file, store } = await fixture();
    await mkdir(path.dirname(file));
    for (const value of ["broken", "null", "{}", '{"version":2,"directory":"/tmp"}', '{"version":1,"directory":"relative"}', '{"version":1,"directory":42}']) {
      await writeFile(file, value);
      expect(await store.defaultPath(home)).toBe(home);
    }
  });

  it("falls back when the saved directory is gone or replaced with a file", async () => {
    const { home, project, store } = await fixture();
    await store.remember(project);
    await rm(project, { recursive: true });
    expect(await store.defaultPath(home)).toBe(home);
    await writeFile(project, "not a directory");
    expect(await store.defaultPath(home)).toBe(home);
  });

  it.skipIf(process.getuid?.() === 0)("falls back for an inaccessible folder", async () => {
    const { home, project, store } = await fixture();
    await store.remember(project);
    await chmod(project, 0);
    try { expect(await store.defaultPath(home)).toBe(home); }
    finally { await chmod(project, 0o700); }
  });

  it("serializes saves so the most recent selection wins", async () => {
    const { home, project, file, store } = await fixture();
    await Promise.all([store.remember(project), store.remember(home)]);
    expect(await store.defaultPath(project)).toBe(home);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, directory: home });
    await expect(store.remember("relative")).rejects.toThrow("must be absolute");
    expect(await store.defaultPath(project)).toBe(home);
  });
});
