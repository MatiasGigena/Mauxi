import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { JournalStore, sha256, type InstrumentationJournal } from "./journal";

const VITE_ANCHOR = "    // Mauxi development integration is inserted here.\n";
const NEXT_ANCHOR = "    // Mauxi development integration is inserted here.\n";

const VITE_PATCH = `    // mauxi-owned:start preview-bridge\n    ...(command === "serve" ? [{\n      name: "mauxi-preview-bridge",\n      transformIndexHtml() {\n        const bridge = \`${"${process.cwd()}"}/.mauxi/bridge.js\`.replaceAll("\\\\", "/");\n        return [{ tag: "script", attrs: { type: "module", src: \`/@fs/\${bridge}\` }, injectTo: "head-prepend" }];\n      },\n    }] : []),\n    // mauxi-owned:end preview-bridge\n`;

const NEXT_PATCH = `    // mauxi-owned:start preview-bridge\n    if (dev && !isServer) {\n      const originalEntry = config.entry;\n      config.entry = async () => {\n        const entries = await originalEntry();\n        const bridge = \`${"${process.cwd()}"}/.mauxi/bridge.js\`;\n        if (entries["main-app"]) {\n          const current = entries["main-app"];\n          entries["main-app"] = Array.isArray(current) ? [bridge, ...current] : [bridge, current];\n        }\n        return entries;\n      };\n    }\n    // mauxi-owned:end preview-bridge\n`;

export interface IntegrationPlan {
  framework: "vite" | "next";
  workspaceRoot: string;
  configPath: string;
  bridgePath: string;
  anchor: string;
  patch: string;
}

export function createIntegrationPlan(workspaceRoot: string, framework: "vite" | "next"): IntegrationPlan {
  const root = path.resolve(workspaceRoot);
  return {
    framework,
    workspaceRoot: root,
    configPath: path.join(root, framework === "vite" ? "vite.config.ts" : "next.config.mjs"),
    bridgePath: path.join(root, ".mauxi", "bridge.js"),
    anchor: framework === "vite" ? VITE_ANCHOR : NEXT_ANCHOR,
    patch: framework === "vite" ? VITE_PATCH : NEXT_PATCH,
  };
}

export function transactionIdFor(plan: IntegrationPlan): string {
  return sha256(plan.workspaceRoot).slice(0, 20);
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

export async function applyIntegration(
  plan: IntegrationPlan,
  store: JournalStore,
  bridgeEntry = path.resolve("src/infrastructure/preview/bridge.ts"),
): Promise<InstrumentationJournal> {
  const config = await readFile(plan.configPath, "utf8");
  if (!config.includes(plan.anchor)) throw new Error(`Integration anchor is missing in ${plan.configPath}`);
  if (config.includes("mauxi-owned:start preview-bridge")) throw new Error(`${plan.configPath} is already instrumented`);
  if (await exists(plan.bridgePath)) throw new Error(`Refusing to replace existing artifact ${plan.bridgePath}`);

  const bridgeBuild = await build({
    entryPoints: [bridgeEntry],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"development"' },
    sourcemap: "inline",
    logLevel: "silent",
    write: false,
  });
  const bridge = Buffer.from(bridgeBuild.outputFiles[0].contents);
  const transactionId = transactionIdFor(plan);
  const now = new Date().toISOString();
  const journal: InstrumentationJournal = {
    version: 1,
    transactionId,
    workspaceRoot: plan.workspaceRoot,
    framework: plan.framework,
    state: "planned",
    createdAt: now,
    updatedAt: now,
    patches: [{
      path: plan.configPath,
      originalHash: sha256(config),
      appliedHash: null,
      ownedText: plan.patch,
      anchor: plan.anchor,
      applied: false,
    }],
    artifacts: [{ path: plan.bridgePath, hash: sha256(bridge), created: true }],
    conflicts: [],
  };
  await store.write(journal);

  journal.state = "applying";
  await store.write(journal);
  await mkdir(path.dirname(plan.bridgePath), { recursive: true });
  await writeFile(plan.bridgePath, bridge);
  await store.write(journal);

  const patched = config.replace(plan.anchor, `${plan.anchor}${plan.patch}`);
  await writeFile(plan.configPath, patched);
  journal.patches[0].applied = true;
  journal.patches[0].appliedHash = sha256(patched);
  journal.state = "applied";
  await store.write(journal);
  return journal;
}

export async function cleanupIntegration(
  transactionId: string,
  store: JournalStore,
): Promise<InstrumentationJournal> {
  const journal = await store.read(transactionId);
  if (journal.state === "clean") return journal;
  journal.state = "cleaning";
  journal.conflicts = [];
  await store.write(journal);

  for (const patch of journal.patches) {
    if (!(await exists(patch.path))) {
      if (patch.applied) journal.conflicts.push(`Patched file is missing: ${patch.path}`);
      continue;
    }
    const current = await readFile(patch.path, "utf8");
    if (current.includes(patch.ownedText)) {
      await writeFile(patch.path, current.replace(patch.ownedText, ""));
      patch.applied = false;
    } else if (patch.applied) {
      journal.conflicts.push(`Owned patch changed or missing: ${patch.path}`);
    }
  }
  for (const artifact of journal.artifacts) {
    if (!artifact.created || !(await exists(artifact.path))) continue;
    const current = await readFile(artifact.path);
    if (sha256(current) !== artifact.hash) {
      journal.conflicts.push(`Owned artifact changed: ${artifact.path}`);
      continue;
    }
    await rm(artifact.path);
    await rmdir(path.dirname(artifact.path)).catch(() => undefined);
    artifact.created = false;
  }
  journal.state = journal.conflicts.length ? "conflicted" : "clean";
  await store.write(journal);
  return journal;
}
