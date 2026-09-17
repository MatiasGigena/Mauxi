import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const signatures = ["mauxi-preview-v1", "data-mauxi-overlay", "React Grab could not resolve", "mauxi-preview-bridge", "mauxi-owned:start preview-bridge", "mauxiSession"];
const roots = ["fixtures/vite/dist", "fixtures/next/.next/static", "fixtures/next/.next/server/app"];
const findings: string[] = [];

async function scan(target: string): Promise<void> {
  const details = await stat(target);
  if (details.isDirectory()) {
    for (const entry of await readdir(target)) await scan(path.join(target, entry));
    return;
  }
  if (details.size > 5_000_000) return;
  const content = await readFile(target, "utf8").catch(() => "");
  for (const signature of signatures) if (content.includes(signature)) findings.push(`${target}: ${signature}`);
}

for (const root of roots) await scan(root);
if (findings.length) throw new Error(`Production output contains Mauxi bridge signatures:\n${findings.join("\n")}`);
console.log("Production output contains no Mauxi bridge signatures.");
