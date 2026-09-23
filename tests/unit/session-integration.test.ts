import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { applyIntegration, cleanupIntegration, prepareIntegrationPlan } from "../../src/infrastructure/instrumentation/plan";
import { JournalStore } from "../../src/infrastructure/instrumentation/journal";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(config = 'module.exports = { allowedDevOrigins: ["custom.local"], distDir: "build", typescript: { tsconfigPath: "tsconfig.json" } };\n') {
  const base = await mkdtemp(path.join(os.tmpdir(), "mauxi-session-")); roots.push(base);
  const root = path.join(base, "app"); await mkdir(root);
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  await writeFile(path.join(root, "next.config.js"), config);
  await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  const bridge = path.join(base, "bridge-entry.js"); await writeFile(bridge, "// bridge\n");
  const store = new JournalStore(path.join(base, "journals"));
  const plan = await prepareIntegrationPlan(root, "next", true);
  return { root, store, plan, bridge, config };
}

it("temporarily adapts Next config and removes only its own edits and private cache", async () => {
  const { root, store, plan, bridge, config } = await setup();
  const beforeTypes = '/// <reference types="next" />\nimport "./build/dev/types/routes.d.ts";\n';
  await writeFile(path.join(root, "next-env.d.ts"), beforeTypes);
  const journal = await applyIntegration(plan, store, bridge);
  const require = createRequire(import.meta.url);
  const wrapped = require(path.join(root, "next.config.js"));
  const dev = await wrapped("phase-development-server", {});
  expect(dev.allowedDevOrigins).toEqual(["custom.local", "127.0.0.1"]);
  expect(dev.distDir).toBe(".mauxi/runtime/next");
  expect((await wrapped("phase-production-build", {})).distDir).toBe("build");
  expect(await readFile(path.join(root, "tsconfig.json"), "utf8")).toBe('{"compilerOptions":{"strict":true}}\n');
  await mkdir(path.join(root, ".mauxi/runtime/next"));
  await writeFile(path.join(root, ".mauxi/runtime/next/cache.js"), "compiled bridge");
  const configPath = path.join(root, "next.config.js");
  await writeFile(configPath, (await readFile(configPath, "utf8")).replace('distDir: "build"', 'distDir: "new-build"') + "// new user edit\n");
  await writeFile(path.join(root, "next-env.d.ts"), JSON.parse(await readFile(path.join(root, ".mauxi/runtime/expected-types.json"), "utf8"))[1] + "declare const userAddition: string;\n");
  await writeFile(path.join(root, "new-component.tsx"), "export const Component = () => null;\n");
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("clean");
  expect(await readFile(configPath, "utf8")).toBe(config.replace('distDir: "build"', 'distDir: "new-build"') + "// new user edit\n");
  expect(await readFile(path.join(root, "next-env.d.ts"), "utf8")).toBe(beforeTypes + "declare const userAddition: string;\n");
  await expect(readFile(path.join(root, "new-component.tsx"))).resolves.toBeTruthy();
  await expect(readFile(path.join(root, ".mauxi/runtime/next/cache.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("clean");
});

it.each([
  'export default { headers: async () => [] };\n',
  'export default async function config() { return { reactStrictMode: true }; }\n',
  'const config = {}; export default config;\n',
])("restores ESM export syntax while preserving new source edits: %s", async config => {
  const { root, store, bridge } = await setup();
  await rm(path.join(root, "next.config.js"));
  await writeFile(path.join(root, "next.config.mjs"), config);
  const plan = await prepareIntegrationPlan(root, "next", true);
  const journal = await applyIntegration(plan, store, bridge);
  const source = await readFile(path.join(root, "next.config.mjs"), "utf8");
  const { transform } = await import("esbuild");
  await expect(transform(source, { loader: "js" })).resolves.toBeTruthy();
  await writeFile(path.join(root, "next.config.mjs"), source + "// user work\n");
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("clean");
  expect(await readFile(path.join(root, "next.config.mjs"), "utf8")).toBe(config + "// user work\n");
});

it("preserves a modified wrapper and reports a repeatable cleanup conflict", async () => {
  const { root, store, plan, bridge } = await setup();
  const journal = await applyIntegration(plan, store, bridge);
  const file = path.join(root, "next.config.js");
  const changed = (await readFile(file, "utf8")).replace("/* mauxi-owned:session-close */", "/* changed */");
  await writeFile(file, changed);
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("conflicted");
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("conflicted");
  expect(await readFile(file, "utf8")).toBe(changed);
});

it("refuses to reuse a cache directory or follow an integration symlink", async () => {
  const { root, store, plan, bridge } = await setup();
  await mkdir(path.join(root, ".mauxi/runtime"), { recursive: true });
  await writeFile(path.join(root, ".mauxi/runtime/user"), "keep");
  await expect(applyIntegration(plan, store, bridge)).rejects.toThrow("already exists");
  await rm(path.join(root, ".mauxi"), { recursive: true });
  const external = path.join(roots[0], "external"); await mkdir(external);
  await symlink(external, path.join(root, ".mauxi"));
  await expect(applyIntegration(plan, store, bridge)).rejects.toThrow("symlink");
});

it("preserves a user edit to a generated declaration rather than restoring the whole file", async () => {
  const { root, store, plan, bridge } = await setup();
  const before = '/// <reference types="next" />\n// pre-existing custom declaration\ndeclare const original: number;\n';
  await writeFile(path.join(root, "next-env.d.ts"), before);
  const journal = await applyIntegration(plan, store, bridge);
  const wrapped = createRequire(import.meta.url)(path.join(root, "next.config.js"));
  await wrapped("phase-development-server", {});
  const expected = JSON.parse(await readFile(path.join(root, ".mauxi/runtime/expected-types.json"), "utf8"))[1];
  await writeFile(path.join(root, "next-env.d.ts"), expected.replace('types="next"', 'types="custom-types"'));
  const result = await cleanupIntegration(journal.transactionId, store);
  expect(result.state, result.conflicts.join("\n")).toBe("clean");
  expect(await readFile(path.join(root, "next-env.d.ts"), "utf8")).toBe(before.replace('types="next"', 'types="custom-types"'));
});

it("keeps overlapping user type edits and recovery data on conflict", async () => {
  const { root, store, plan, bridge } = await setup();
  await writeFile(path.join(root, "next-env.d.ts"), '/// <reference types="next" />\nimport "./build/types/routes.d.ts";\n');
  const journal = await applyIntegration(plan, store, bridge);
  await createRequire(import.meta.url)(path.join(root, "next.config.js"))("phase-development-server", {});
  const expected = JSON.parse(await readFile(path.join(root, ".mauxi/runtime/expected-types.json"), "utf8"))[1];
  const userContent = expected.replace('types/routes.d.ts', 'types/user-route.d.ts');
  await writeFile(path.join(root, "next-env.d.ts"), userContent);
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("conflicted");
  expect(await readFile(path.join(root, "next-env.d.ts"), "utf8")).toBe(userContent);
  expect((await cleanupIntegration(journal.transactionId, store)).state).toBe("conflicted");
  await expect(readFile(path.join(root, ".mauxi/runtime/owner"))).resolves.toBeTruthy();
});
