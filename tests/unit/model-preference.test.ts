import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadModelPreference, saveModelPreference } from "../../src/infrastructure/agent/model-preference";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function profile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-model-preference-"));
  roots.push(root);

  return root;
}

it("stores provider and full model ID privately, replacing the last choice without temporary files", async () => {
  const root = await profile();
  expect(await loadModelPreference(root)).toEqual({});
  await saveModelPreference(root, "first", "one");
  await saveModelPreference(root, "second", "vendor/model");
  expect(await loadModelPreference(root)).toEqual({ defaultProvider: "second", defaultModel: "vendor/model" });
  expect((await stat(path.join(root, "model-preference.json"))).mode & 0o777).toBe(0o600);
  expect(await readdir(root)).toEqual(["model-preference.json"]);
  expect(JSON.parse(await readFile(path.join(root, "model-preference.json"), "utf8"))).toEqual({
    defaultProvider: "second", defaultModel: "vendor/model",
  });
});

it.each(["{", "null", "[]", "{}", '{"defaultProvider":"fake"}', '{"defaultProvider":1,"defaultModel":"one"}',
  '{"defaultProvider":"fake","defaultModel":""}'])("ignores malformed or incomplete preferences: %s", async content => {
  const root = await profile();
  await writeFile(path.join(root, "model-preference.json"), content);
  expect(await loadModelPreference(root)).toEqual({});
});

it("loads only model identity, not executable SDK settings", async () => {
  const root = await profile();
  await writeFile(path.join(root, "model-preference.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "two", packages: ["untrusted"], extensions: ["untrusted"], retry: { maxRetries: 999 },
  }));
  expect(await loadModelPreference(root)).toEqual({ defaultProvider: "fake", defaultModel: "two" });
});
