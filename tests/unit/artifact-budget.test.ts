import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_LIMITS, assertArtifactCapacity, writeCapture } from "../../src/infrastructure/storage/artifact-budget";
import { guardSessionStorage } from "../../src/infrastructure/agent/session-budget";
import { JournalStore, type InstrumentationJournal } from "../../src/infrastructure/instrumentation/journal";

const roots: string[] = [];
const limits = structuredClone(ARTIFACT_LIMITS);

const root = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "mauxi-budget-")); roots.push(dir);

return dir; };

afterEach(() => { Object.assign(ARTIFACT_LIMITS, structuredClone(limits));

for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("admits exactly the capture byte/count bounds and preserves old captures at capacity", () => {
  const dir = root(); ARTIFACT_LIMITS.captures = { files: 2, bytes: 5 };
  writeCapture(path.join(dir, "one.png"), Buffer.from("abc"));
  writeCapture(path.join(dir, "two.png"), Buffer.from("de"));
  expect(() => writeCapture(path.join(dir, "three.png"), Buffer.from("f"))).toThrow(/Storage capacity/);
  expect(readFileSync(path.join(dir, "one.png"), "utf8")).toBe("abc");
  expect(() => assertArtifactCapacity(dir, { files: 1, bytes: 100 }, 0)).toThrow(/Storage capacity/);
  expect(() => assertArtifactCapacity(dir, { files: 3, bytes: 5 }, 1)).toThrow(/Storage capacity/);
});

it("budgets native SDK lazy flush and resumed appends across workspaces without pruning history", () => {
  const dir = root(); const a = path.join(dir, "a"); const b = path.join(dir, "b"); mkdirSync(a); mkdirSync(b);
  const failures: Error[] = [];
  const manager = SessionManager.create(dir, a);
  guardSessionStorage(manager, dir, error => failures.push(error));
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-completions", provider: "local", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const file = manager.getSessionFile()!; const saved = readFileSync(file);
  writeFileSync(path.join(b, "other.jsonl"), "other history");
  ARTIFACT_LIMITS.sessions = { files: 2, bytes: saved.length + 13 };
  const resumed = SessionManager.open(file, a);
  guardSessionStorage(resumed, dir, error => failures.push(error));
  expect(() => resumed.appendSessionInfo("rename beyond capacity")).toThrow(/Storage capacity/);
  expect(readFileSync(file)).toEqual(saved);
  expect(readFileSync(path.join(b, "other.jsonl"), "utf8")).toBe("other history");
  const fresh = SessionManager.create(dir, b); guardSessionStorage(fresh, dir, error => failures.push(error));
  expect(() => fresh.appendMessage({ role: "user", content: "pending context", timestamp: Date.now() })).toThrow(/Storage capacity/);
  expect(failures).toHaveLength(2);
  ARTIFACT_LIMITS.sessions = limits.sessions;
  expect(() => resumed.appendSessionInfo("must resume before writing again")).toThrow(/Storage capacity/);
  expect(readFileSync(file)).toEqual(saved);
});

it("blocks new journals at capacity but permits unfinished recovery updates", async () => {
  const dir = root(); const store = new JournalStore(dir);
  ARTIFACT_LIMITS.journals = { files: 1, bytes: 3 * 1024 * 1024 };
  const journal: InstrumentationJournal = { version: 1, transactionId: "one", workspaceRoot: "/project", framework: "vite", state: "planned", createdAt: "now", updatedAt: "now", patches: [], artifacts: [], conflicts: [] };
  await store.write(journal);
  await expect(store.write({ ...journal, transactionId: "two" })).rejects.toThrow(/Storage capacity/);
  ARTIFACT_LIMITS.journals.bytes = 1;
  await store.write({ ...journal, state: "conflicted", conflicts: ["retain before-images"] });
  expect((await store.read("one")).conflicts).toEqual(["retain before-images"]);
  ARTIFACT_LIMITS.journals.files = 10;
  await expect(store.write({ ...journal, transactionId: "three" })).rejects.toThrow(/Storage capacity/);
});
