import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ARTIFACT_LIMITS } from "../../src/infrastructure/storage/artifact-budget";
import { CaptureCache, CAPTURE_RETENTION } from "../../src/infrastructure/storage/capture-cache";

const roots: string[] = [];
const limits = structuredClone(ARTIFACT_LIMITS);
const now = Date.now();

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mauxi-captures-")); roots.push(dir);
  const root = path.join(dir, "captures"); mkdirSync(root);

  return { dir, root, cache: new CaptureCache(root, () => now) };
}

function seed(root: string, name: string, age = 0, content = "png"): string {
  const file = path.join(root, name); writeFileSync(file, content);
  utimesSync(file, new Date(now - age), new Date(now - age));

  return file;
}

afterEach(() => {
  Object.assign(ARTIFACT_LIMITS, structuredClone(limits));

  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("reclaims the observed 325 legacy orphaned selections on startup, even over the file limit", () => {
  const { root, cache } = setup();

  for (let i = 0; i < 325; i++) seed(root, `desktop-selection-pick-${i}-${now + i}.png`);
  const preview = seed(root, `mobile-${now}.png`);
  expect(cache.cleanup()).toEqual({ removedFiles: 325, removedBytes: 975 });
  expect(readdirSync(root)).toEqual([path.basename(preview)]);
  expect(cache.write("desktop", Buffer.from("new"), "live-pick")).toBeTruthy();
});

it("expires standalone previews at 24 hours, not earlier, including legacy filenames", () => {
  const { root, cache } = setup();
  const expired = seed(root, `desktop-${now - 1}.png`, CAPTURE_RETENTION.previewMaxAgeMs);
  const recent = seed(root, `mobile-${now}.png`, CAPTURE_RETENTION.previewMaxAgeMs - 1);
  expect(cache.cleanup().removedFiles).toBe(1);
  expect(existsSync(expired)).toBe(false); expect(existsSync(recent)).toBe(true);
  expect(cache.cleanup().removedFiles).toBe(0);
});

it("keeps active draft captures across periodic sweeps and deletes removed/accepted selections immediately", () => {
  const { root } = setup(); let time = now;
  const cache = new CaptureCache(root, () => time);
  const file = cache.write("desktop", Buffer.from("draft pixels"), "active");
  time += 2 * CAPTURE_RETENTION.previewMaxAgeMs;
  expect(cache.cleanup().removedFiles).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("draft pixels");
  cache.releaseDrafts([file]);
  expect(cache.cleanup()).toEqual({ removedFiles: 1, removedBytes: 12 });
  expect(existsSync(file)).toBe(false);
});

it("protects in-flight inputs after chip removal/window replacement, with independent reference counts", () => {
  const { cache } = setup();
  const file = cache.write("mobile", Buffer.from("in use"), "pending");
  const releaseA = cache.protectInputs([file, file]); const releaseB = cache.protectInputs([file]);
  cache.releaseDrafts([file]); cache.clearDrafts();
  expect(cache.cleanup().removedFiles).toBe(0);
  releaseA(); releaseA();
  expect(cache.cleanup().removedFiles).toBe(0);
  releaseB();
  expect(cache.cleanup().removedFiles).toBe(1);
});


it("clears abandoned drafts after restart/window retirement without removing recent standalone previews", () => {
  const { root, cache } = setup();
  const draft = cache.write("desktop", Buffer.from("draft"), "abandoned");
  const preview = cache.write("mobile", Buffer.from("preview"));
  cache.clearDrafts(); cache.cleanup();
  expect(existsSync(draft)).toBe(false); expect(existsSync(preview)).toBe(true);
  const another = cache.write("desktop", Buffer.from("draft"), "crashed");
  expect(new CaptureCache(root, () => now).cleanup().removedFiles).toBe(1);
  expect(existsSync(another)).toBe(false); expect(existsSync(preview)).toBe(true);
});

it("reserves the new file before pruning oldest previews to 75% of the count limit", () => {
  const { root } = setup(); let time = now;
  const cache = new CaptureCache(root, () => time++);
  ARTIFACT_LIMITS.captures = { files: 4, bytes: 1000 };
  const old = seed(root, `desktop-${now - 1}.png`, 10);
  const saved: string[] = [];

  for (let i = 0; i < 30; i++) {
    const file = cache.write("desktop", Buffer.from("png"));
    utimesSync(file, new Date(time), new Date(time)); saved.push(file);
    expect(readdirSync(root).length).toBeLessThanOrEqual(3);
  }

  expect(existsSync(old)).toBe(false);
  expect(saved.slice(-3).every(file => existsSync(file))).toBe(true);
  expect(saved.slice(0, -3).every(file => !existsSync(file))).toBe(true);
});

it("reserves new bytes as well as file count and preserves active selections under byte pressure", () => {
  const { root } = setup(); let time = now;
  const cache = new CaptureCache(root, () => time++);
  ARTIFACT_LIMITS.captures = { files: 20, bytes: 12 };
  const draft = cache.write("desktop", Buffer.from("1234"), "active");
  const old = seed(root, `mobile-${now}.png`, 10, "5678");
  const newest = cache.write("mobile", Buffer.from("abcd"));
  expect(existsSync(old)).toBe(false);
  expect(readFileSync(draft, "utf8")).toBe("1234"); expect(existsSync(newest)).toBe(true);
  expect(readdirSync(root).reduce((sum, name) => sum + statSync(path.join(root, name)).size, 0)).toBe(8);
});

it("allows a single image over the soft watermark but never over the hard budget", () => {
  const { cache } = setup(); ARTIFACT_LIMITS.captures = { files: 4, bytes: 10 };
  const file = cache.write("desktop", Buffer.alloc(10));
  expect(() => cache.write("desktop", Buffer.alloc(11))).toThrow(/storage budget/);
  expect(readFileSync(file)).toHaveLength(10);
});

it("refuses rather than evicting protected attachments when they fill the hard limit", () => {
  const { cache } = setup(); ARTIFACT_LIMITS.captures = { files: 2, bytes: 100 };
  const first = cache.write("desktop", Buffer.from("first"), "first");
  const second = cache.write("mobile", Buffer.from("second"), "second");
  expect(() => cache.write("desktop", Buffer.from("third"), "third")).toThrow(/Storage capacity/);
  expect(readFileSync(first, "utf8")).toBe("first"); expect(readFileSync(second, "utf8")).toBe("second");
});

it("preserves unknown filenames, nested files and files outside the capture root while counting them", () => {
  const { dir, root, cache } = setup(); ARTIFACT_LIMITS.captures = { files: 3, bytes: 100 };
  const unknown = seed(root, "exported-preview.png", 2 * CAPTURE_RETENTION.previewMaxAgeMs);
  mkdirSync(path.join(root, "archive"));
  const nested = seed(path.join(root, "archive"), `desktop-selection-archived-${now}.png`);
  const outside = seed(dir, `desktop-selection-outside-${now}.png`);
  const draft = cache.write("desktop", Buffer.from("draft"), "current");
  cache.releaseDrafts([outside, path.join(root, "..", path.basename(draft))]); cache.cleanup();

  for (const file of [unknown, nested, outside, draft]) expect(existsSync(file)).toBe(true);
  expect(() => cache.write("mobile", Buffer.from("more"), "more")).toThrow(/Storage capacity/);
});

it("refuses symlinks before deleting any recognized capture", () => {
  const { dir, root, cache } = setup();
  const orphan = seed(root, `desktop-selection-orphan-${now}.png`);
  const outside = seed(dir, "private.png");
  symlinkSync(outside, path.join(root, `mobile-${now}.png`));
  expect(() => cache.cleanup()).toThrow(/Unexpected storage entry/);
  expect(existsSync(orphan)).toBe(true); expect(readFileSync(outside, "utf8")).toBe("png");
  const alias = path.join(dir, "capture-alias"); symlinkSync(root, alias);
  expect(() => new CaptureCache(alias).cleanup()).toThrow(/Unexpected storage directory/);
});

it("bounds a complete cleanup scan before removing anything", () => {
  const { root, cache } = setup(); const orphan = seed(root, `desktop-selection-orphan-${now}.png`);

  for (let i = 0; i < 4096; i++) seed(root, `unknown-${i}.txt`);
  expect(() => cache.cleanup()).toThrow(/4,096 entries/);
  expect(existsSync(orphan)).toBe(true);
});

it("reports deletion failures without writing past the budget or deleting protected drafts", () => {
  const { root, cache } = setup(); const draft = cache.write("desktop", Buffer.from("draft"), "active");
  const orphan = seed(root, `mobile-selection-orphan-${now}.png`);
  chmodSync(root, 0o500);

  try {
    expect(() => cache.write("mobile", Buffer.from("new"))).toThrow();
    expect(existsSync(draft)).toBe(true); expect(existsSync(orphan)).toBe(true);
    expect(readdirSync(root)).toHaveLength(2);
  } finally { chmodSync(root, 0o700); }
});

it("uses private, collision-free filenames for repeated captures in the same millisecond", () => {
  const { cache } = setup(); const first = cache.write("desktop", Buffer.from("one"));
  const second = cache.write("desktop", Buffer.from("two"));
  expect(second).not.toBe(first);
  expect(statSync(first).mode & 0o777).toBe(0o600);
  expect(readFileSync(first, "utf8")).toBe("one"); expect(readFileSync(second, "utf8")).toBe("two");
  expect(() => cache.write("desktop", Buffer.from("unsafe"), "../escape")).toThrow(/identity/);
});
