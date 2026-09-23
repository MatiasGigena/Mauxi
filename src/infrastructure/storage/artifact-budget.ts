import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ArtifactBudget { files: number; bytes: number }
export const ARTIFACT_LIMITS = {
  captures: { files: 256, bytes: 128 * 1024 * 1024 },
  sessions: { files: 512, bytes: 256 * 1024 * 1024 },
  journals: { files: 128, bytes: 128 * 1024 * 1024 },
} satisfies Record<string, ArtifactBudget>;

// Synchronous admission + write is serialized by the Electron main thread.
// These are application admission budgets, not physical disk quotas. External
// writers can exceed them; no user history or recovery data is ever evicted.
export function assertArtifactCapacity(root: string, limits: ArtifactBudget, addedBytes: number, addedFiles = 0): void {
  let bytes = 0; let files = 0; let visited = 0;
  const full = () => new Error(`Storage capacity at ${root}: ${files} files / ${bytes} bytes; admission limit ${limits.files} files / ${limits.bytes} bytes (requested +${addedFiles} files / +${addedBytes} bytes). Stop Mauxi, back up and review this directory, then manually remove only unneeded captures, completed clean journals, or explicitly chosen conversations. Never delete unfinished recovery records. See docs/private-alpha.md.`);
  const visit = (directory: string) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return; throw error; }
    for (const entry of entries) {
      if (++visited > 4096) throw full();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const info = lstatSync(file);
        if (!info.isFile()) throw new Error(`Unexpected storage entry at ${file}; review it manually before writing.`);
        files++; bytes += info.size;
        if (files + addedFiles > limits.files || bytes + addedBytes > limits.bytes) throw full();
      }
    }
  };
  visit(root);
  if (files + addedFiles > limits.files || bytes + addedBytes > limits.bytes) throw full();
}

export function writeCapture(file: string, data: Buffer): void {
  assertArtifactCapacity(path.dirname(file), ARTIFACT_LIMITS.captures, data.length, 1);
  writeFileSync(file, data, { flag: "wx", mode: 0o600 });
}
