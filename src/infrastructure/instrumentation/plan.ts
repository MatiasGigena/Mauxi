import { addSessionIntegration, type SessionPatch } from "./session";
import { cleanSessionFiles, stopSessionProcess } from "./session-cleanup";
import { randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { lstat, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { JournalStore, sha256, type InstrumentationJournal } from "./journal";

const MAX_CONFIG_BYTES = 524_288;
const VITE_ANCHOR = "    // Mauxi development integration is inserted here.\n";
const VITE_PATCH = `    // mauxi-owned:start preview-bridge\n    {\n      name: "mauxi-preview-bridge",\n      apply: "serve",\n      transformIndexHtml() {\n        const bridge = \`${"${process.cwd()}"}/.mauxi/bridge.js\`.replaceAll("\\\\", "/");\n        return [{ tag: "script", attrs: { type: "module", src: \`/@fs/\${bridge}\` }, injectTo: "head-prepend" }];\n      },\n    },\n    // mauxi-owned:end preview-bridge\n`;

function relativeModulePath(fromDirectory: string, target: string): string {
  const relative = path.relative(fromDirectory, target).split(path.sep).join("/");
  return relative.startsWith("./") || relative.startsWith("../") ? relative : `./${relative}`;
}

function nextClientHook(importPath: string, leadingNewline = false): string {
  return `${leadingNewline ? "\n" : ""}// mauxi-owned:start preview-bridge
if (process.env.NODE_ENV === "development" && (new URLSearchParams(window.location.search).has("mauxiSession") || (() => {
  try {
    const previous = JSON.parse(window.name.startsWith("mauxi:") ? window.name.slice(6) : "null");
    return window.parent !== window && previous?.origin === window.location.origin && typeof previous.session === "string" && previous.session.length > 0;
  } catch { return false; }
})())) {
  // @ts-ignore -- temporary Mauxi-owned JavaScript has no project declaration file.
  void import(${JSON.stringify(importPath)});
}
// mauxi-owned:end preview-bridge
`;
}

export interface IntegrationPlan {
  framework: "vite" | "next";
  workspaceRoot: string;
  configPath: string;
  bridgePath: string;
  anchor: string | null;
  patch: string | null;
  placement: "after" | "append";
  runtimeDirectory?: string;
  sessionPatches?: SessionPatch[];
  sessionRemovals?: string[];
  createdFiles: Array<{ path: string; content: string }>;
}

export function createIntegrationPlan(workspaceRoot: string, framework: "vite" | "next"): IntegrationPlan {
  const root = path.resolve(workspaceRoot);
  if (framework === "next") {
    const clientPath = path.join(root, "instrumentation-client.js");
    return {
      framework,
      workspaceRoot: root,
      configPath: clientPath,
      bridgePath: path.join(root, ".mauxi", "bridge.js"),
      anchor: null,
      patch: null,
      placement: "append",
      createdFiles: [{ path: clientPath, content: nextClientHook("./.mauxi/bridge.js") }],
    };
  }
  return {
    framework,
    workspaceRoot: root,
    configPath: path.join(root, "vite.config.ts"),
    bridgePath: path.join(root, ".mauxi", "bridge.js"),
    anchor: VITE_ANCHOR,
    patch: VITE_PATCH,
    placement: "after",
    createdFiles: [],
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

async function firstExistingConfig(root: string): Promise<string | null> {
  for (const name of ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs", "vite.config.mts", "vite.config.cts"]) {
    if (!(await exists(path.join(root, name)))) continue;
    if (name.endsWith(".cjs") || name.endsWith(".cts")) throw new Error(`Vite loads ${name}, which Mauxi does not support yet. Mauxi made no changes.`);
    return path.join(root, name);
  }
  return null;
}

async function prepareVitePlan(root: string): Promise<IntegrationPlan> {
  const configPath = await firstExistingConfig(root);
  if (!configPath) throw new Error("No supported Vite configuration file was found.");
  const file = await lstat(configPath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Configuration must be a regular, non-symlink file: ${configPath}`);
  if (file.size > MAX_CONFIG_BYTES) throw new Error(`Configuration is larger than ${MAX_CONFIG_BYTES} bytes; Mauxi made no changes.`);
  const config = await readFile(configPath, "utf8");
  let anchor = VITE_ANCHOR;
  let patch = VITE_PATCH;
  if (!config.includes(anchor)) {
    const arrays: number[] = [];
    const pending: Node[] = [parse(config, { sourceType: "unambiguous", plugins: ["typescript"] })];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "ObjectProperty" && !node.computed
        && ((node.key.type === "Identifier" && node.key.name === "plugins")
          || (node.key.type === "StringLiteral" && node.key.value === "plugins"))
        && node.value.type === "ArrayExpression") arrays.push(node.value.start!);
      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === "object" && typeof child.type === "string") pending.push(child as Node);
        }
      }
    }
    if (arrays.length !== 1) throw new Error("The Vite plugins array is missing or ambiguous. Mauxi made no changes.");
    anchor = config.slice(0, arrays[0] + 1);
    patch = `\n${VITE_PATCH}`;
  }
  return {
    framework: "vite",
    workspaceRoot: root,
    configPath,
    bridgePath: path.join(root, ".mauxi", "bridge.js"),
    anchor,
    patch,
    placement: "after",
    createdFiles: [],
  };
}

async function prepareNextPlan(root: string): Promise<IntegrationPlan> {
  const candidates = [
    "instrumentation-client.ts",
    "instrumentation-client.js",
    "instrumentation-client.tsx",
    "instrumentation-client.jsx",
    "src/instrumentation-client.ts",
    "src/instrumentation-client.js",
    "src/instrumentation-client.tsx",
    "src/instrumentation-client.jsx",
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    const filePath = path.join(root, candidate);
    if (await exists(filePath)) existing.push(filePath);
  }
  if (existing.length > 1) throw new Error("Multiple instrumentation-client files were found. Mauxi cannot choose one safely.");
  const bridgePath = path.join(root, ".mauxi", "bridge.js");
  if (existing.length === 1) {
    const clientPath = existing[0];
    const file = await lstat(clientPath);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Instrumentation client must be a regular, non-symlink file: ${clientPath}`);
    if (file.size > MAX_CONFIG_BYTES) throw new Error(`Instrumentation client is larger than ${MAX_CONFIG_BYTES} bytes; Mauxi made no changes.`);
    const content = await readFile(clientPath, "utf8");
    if (content.includes("mauxi-owned:start preview-bridge")) throw new Error(`${clientPath} is already instrumented`);
    const importPath = relativeModulePath(path.dirname(clientPath), bridgePath);
    return {
      framework: "next",
      workspaceRoot: root,
      configPath: clientPath,
      bridgePath,
      anchor: null,
      patch: nextClientHook(importPath, content.length > 0 && !content.endsWith("\n")),
      placement: "append",
      createdFiles: [],
    };
  }

  const useSrc = await exists(path.join(root, "src", "app")) || await exists(path.join(root, "src", "pages"));
  const clientPath = path.join(root, useSrc ? "src/instrumentation-client.js" : "instrumentation-client.js");
  const importPath = relativeModulePath(path.dirname(clientPath), bridgePath);
  return {
    framework: "next",
    workspaceRoot: root,
    configPath: clientPath,
    bridgePath,
    anchor: null,
    patch: null,
    placement: "append",
    createdFiles: [{ path: clientPath, content: nextClientHook(importPath) }],
  };
}

export async function prepareIntegrationPlan(workspaceRoot: string, framework: "vite" | "next", ownedSession = false): Promise<IntegrationPlan> {
  const root = path.resolve(workspaceRoot);
  const plan = await (framework === "vite" ? prepareVitePlan(root) : prepareNextPlan(root));
  return ownedSession ? addSessionIntegration(plan) : plan;
}

export async function previewIntegrationPlan(workspaceRoot: string, framework: "vite" | "next") {
  const plan = await prepareIntegrationPlan(workspaceRoot, framework, true);
  const relative = (filePath: string) => path.relative(plan.workspaceRoot, filePath).split(path.sep).join("/");
  const files: Array<{ path: string; action: "modify" | "create"; diff: string }> = [];
  if (plan.patch) {
    files.push({ path: relative(plan.configPath), action: "modify", diff: `+${plan.patch.trimEnd().replaceAll("\n", "\n+")}` });
  }
  for (const artifact of plan.createdFiles) {
    files.push({ path: relative(artifact.path), action: "create", diff: `+${artifact.content.trimEnd().replaceAll("\n", "\n+")}` });
  }
  for (const patch of plan.sessionPatches ?? []) files.push({ path: relative(patch.path), action: "modify", diff: "+ Temporary development configuration wrapper; removed on close" });
  files.push({ path: ".mauxi/runtime/", action: "create", diff: "+ Private development cache; removed after the owned server stops" });
  files.push({ path: ".mauxi/bridge.js", action: "create", diff: "+ Bundled Mauxi preview bridge (development only)" });
  return {
    supported: true,
    summary: framework === "next"
      ? "Use Next.js instrumentation-client to load the preview bridge only for a Mauxi development URL."
      : "Add a development-only Vite preview bridge. Cleanup removes only the marked region and owned artifact.",
    files,
  };
}

export function transactionIdFor(plan: IntegrationPlan): string {
  return sha256(plan.workspaceRoot).slice(0, 20);
}

async function atomicWrite(filePath: string, content: string | Buffer, mode?: number): Promise<void> {
  const temporaryPath = `${filePath}.mauxi-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode });
  await rename(temporaryPath, filePath);
}

export async function applyIntegration(
  plan: IntegrationPlan,
  store: JournalStore,
  bridgeEntry = path.resolve("src/infrastructure/preview/bridge.ts"),
): Promise<InstrumentationJournal> {
  const mauxiDirectory = path.join(plan.workspaceRoot, ".mauxi");
  try {
    const info = await lstat(mauxiDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Mauxi directory must not be a symlink or file.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (plan.runtimeDirectory) {
    try { await lstat(plan.runtimeDirectory); throw new Error("Session cache already exists; recover it before opening this project."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let originalContent: string | null = null;
  let configMode: number | undefined;
  if (plan.patch) {
    const configFile = await lstat(plan.configPath);
    if (!configFile.isFile() || configFile.isSymbolicLink()) throw new Error(`Refusing to instrument non-regular file ${plan.configPath}`);
    if (configFile.size > MAX_CONFIG_BYTES) throw new Error(`Refusing to instrument file larger than ${MAX_CONFIG_BYTES} bytes`);
    originalContent = await readFile(plan.configPath, "utf8");
    configMode = configFile.mode;
    if (plan.anchor && !originalContent.includes(plan.anchor)) throw new Error(`Integration anchor is missing in ${plan.configPath}`);
    if (originalContent.includes("mauxi-owned:start preview-bridge")) throw new Error(`${plan.configPath} is already instrumented`);
  }
  if (await exists(plan.bridgePath)) throw new Error(`Refusing to replace existing artifact ${plan.bridgePath}`);
  for (const artifact of plan.createdFiles) {
    if (await exists(artifact.path)) throw new Error(`Refusing to replace existing artifact ${artifact.path}`);
  }
  const unfinished = (await store.list()).filter((entry) => entry.state !== "clean");
  const transactionId = transactionIdFor(plan);
  if (unfinished.length >= 64 && !unfinished.some((entry) => entry.transactionId === transactionId)) {
    throw new Error("Mauxi has 64 unfinished recovery records. Resolve them before instrumenting another project.");
  }

  let bridge: Buffer;
  if (bridgeEntry.endsWith("bridge-entry.js")) bridge = await readFile(bridgeEntry);
  else {
    const { build } = await import("esbuild");
    const bridgeBuild = await build({
      entryPoints: [bridgeEntry], bundle: true, platform: "browser", format: "esm", target: "es2022",
      define: { "process.env.NODE_ENV": '"development"' }, sourcemap: "inline", logLevel: "silent", write: false,
    });
    bridge = Buffer.from(bridgeBuild.outputFiles[0].contents);
  }

  const now = new Date().toISOString();
  const createdArtifacts = [
    { path: plan.bridgePath, content: bridge as string | Buffer },
    ...plan.createdFiles.map((artifact) => ({ path: artifact.path, content: artifact.content as string | Buffer })),
  ];
  const journal: InstrumentationJournal = {
    version: 1,
    transactionId,
    workspaceRoot: plan.workspaceRoot,
    framework: plan.framework,
    state: "planned",
    createdAt: now,
    updatedAt: now,
    patches: plan.patch && originalContent !== null ? [{
      path: plan.configPath,
      originalHash: sha256(originalContent),
      appliedHash: null,
      ownedText: plan.patch,
      originalContent,
      anchor: plan.anchor ?? "<append>",
      applied: false,
    }] : [],
    artifacts: createdArtifacts.map((artifact) => ({ path: artifact.path, hash: sha256(artifact.content), created: true, written: false })),
    conflicts: [],
  };
  for (const patch of plan.sessionPatches ?? []) {
    if (await readFile(patch.path, "utf8") !== patch.before) throw new Error("Configuration changed before session setup.");
    journal.patches.push({ path: patch.path, originalHash: sha256(patch.before), originalContent: patch.before, appliedHash: null, ownedText: "", ownedParts: plan.sessionRemovals, anchor: "<session>", applied: false });
  }
  if (plan.runtimeDirectory) {
    journal.runtime = { path: plan.runtimeDirectory, token: randomUUID(), created: false };
    if (plan.framework === "next") {
      const typesPath = path.join(plan.workspaceRoot, "next-env.d.ts");
      let before: string | null = null;
      try {
        const info = await lstat(typesPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error("Unsupported Next type declaration file.");
        before = await readFile(typesPath, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      journal.generatedTypes = { path: typesPath, before };
    }
  }
  await store.write(journal);
  journal.state = "applying";
  await store.write(journal);

  if (journal.runtime) {
    await mkdir(path.dirname(journal.runtime.path), { recursive: true });
    await mkdir(journal.runtime.path);
    await writeFile(path.join(journal.runtime.path, "owner"), journal.runtime.token, { flag: "wx", mode: 0o600 });
    journal.runtime.created = true;
    await store.write(journal);
  }
  for (const [index, artifact] of createdArtifacts.entries()) {
    await mkdir(path.dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content, { flag: "wx", mode: 0o600 });
    journal.artifacts[index].written = true;
    await store.write(journal);
  }

  if (plan.patch && originalContent !== null) {
    const latest = await readFile(plan.configPath, "utf8");
    if (sha256(latest) !== sha256(originalContent)) throw new Error(`File changed while setup was being prepared: ${plan.configPath}`);
    const patched = plan.placement === "append"
      ? `${originalContent}${plan.patch}`
      : originalContent.replace(plan.anchor!, () => `${plan.anchor}${plan.patch}`);
    await atomicWrite(plan.configPath, patched, configMode);
    journal.patches[0].applied = true;
    journal.patches[0].appliedHash = sha256(patched);
  }
  for (const patch of plan.sessionPatches ?? []) {
    const info = await lstat(patch.path);
    if (!info.isFile() || info.isSymbolicLink() || await readFile(patch.path, "utf8") !== patch.before) throw new Error("Configuration changed during session setup.");
    await atomicWrite(patch.path, patch.after, info.mode);
    const record = journal.patches.find(item => item.path === patch.path)!;
    record.applied = true;
    record.appliedHash = sha256(patch.after);
    await store.write(journal);
  }
  journal.state = "applied";
  await store.write(journal);
  return journal;
}

export async function cleanupIntegration(transactionId: string, store: JournalStore): Promise<InstrumentationJournal> {
  const journal = await store.read(transactionId);
  if (journal.state === "clean") return journal;
  await stopSessionProcess(journal);
  journal.state = "cleaning";
  journal.conflicts = [];
  await store.write(journal);

  for (const patch of journal.patches) {
    if (patch.cleaned) continue;
    if (!(await exists(patch.path))) {
      journal.conflicts.push(`Patched file is missing or moved; restore its original path before retrying cleanup: ${patch.path}`);
      continue;
    }
    const currentFile = await lstat(patch.path);
    if (!currentFile.isFile() || currentFile.isSymbolicLink()) {
      journal.conflicts.push(`Patched path is no longer a regular file: ${patch.path}`);
      continue;
    }
    const current = await readFile(patch.path, "utf8");
    const parts = patch.ownedParts ?? [patch.ownedText];
    if (!patch.applied && !current.includes("mauxi-owned:") && parts.every(part => !part || !current.includes(part))) {
      patch.cleaned = true;
      await store.write(journal);
      continue;
    }
    if (parts.every(part => part && current.split(part).length === 2)) {
      let cleaned = current;
      for (const part of parts) cleaned = cleaned.replace(part, "");
      await atomicWrite(patch.path, cleaned, currentFile.mode);
      patch.applied = false;
      patch.cleaned = true;
      await store.write(journal);
    } else journal.conflicts.push(`Owned patch changed or missing: ${patch.path}`);
  }
  for (const artifact of journal.artifacts) {
    if (!artifact.created) continue;
    if (!(await exists(artifact.path)) && artifact.written === false) {
      artifact.created = false;
      await store.write(journal);
      continue;
    }
    if (!(await exists(artifact.path))) {
      journal.conflicts.push(`Owned artifact is missing or moved; restore its original path before retrying cleanup: ${artifact.path}`);
      continue;
    }
    const current = await readFile(artifact.path);
    if (sha256(current) !== artifact.hash) {
      journal.conflicts.push(`Owned artifact changed: ${artifact.path}`);
      continue;
    }
    await rm(artifact.path);
    await rmdir(path.dirname(artifact.path)).catch(() => undefined);
    artifact.created = false;
    await store.write(journal);
  }
  if (!journal.conflicts.length) {
    try { await cleanSessionFiles(journal, store); }
    catch (error) { journal.conflicts.push(error instanceof Error ? error.message : String(error)); }
  }
  journal.state = journal.conflicts.length ? "conflicted" : "clean";
  await store.write(journal);
  return journal;
}
