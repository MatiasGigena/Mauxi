import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ArtifactBudget { files: number; bytes: number }
export const ARTIFACT_LIMITS = {
  captures: { files: 256, bytes: 128 * 1024 * 1024 },
  sessions: { files: 512, bytes: 256 * 1024 * 1024 },
  journals: { files: 128, bytes: 128 * 1024 * 1024 },
} satisfies Record<string, ArtifactBudget>;

export interface StorageArtifact { file: string; size: number; mtimeMs: number; dev: number; ino: number }

export function scanArtifacts(root: string): StorageArtifact[] {
  const artifacts: StorageArtifact[] = []; let visited = 0;
  const visit = (directory: string) => {
    let entries;
    try {
      if (!lstatSync(directory).isDirectory()) throw new Error(`Unexpected storage directory at ${directory}; review it manually before writing.`);
      entries = readdirSync(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return; throw error; }
    for (const name of entries) {
      if (++visited > 4096) throw new Error(`Storage capacity scan at ${root} exceeds 4,096 entries; review it manually before writing.`);
      const file = path.join(directory, name); const info = lstatSync(file);
      if (info.isDirectory()) visit(file);
      else {
        if (!info.isFile()) throw new Error(`Unexpected storage entry at ${file}; review it manually before writing.`);
        artifacts.push({ file, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino });
      }
    }
  };
  visit(root);
  return artifacts;
}

export function assertArtifactCapacity(root: string, limits: ArtifactBudget, addedBytes: number, addedFiles = 0): void {
  const artifacts = scanArtifacts(root);
  const bytes = artifacts.reduce((sum, item) => sum + item.size, 0); const files = artifacts.length;
  if (files + addedFiles > limits.files || bytes + addedBytes > limits.bytes) {
    throw new Error(`Storage capacity at ${root}: ${files} files / ${bytes} bytes; admission limit ${limits.files} files / ${limits.bytes} bytes (requested +${addedFiles} files / +${addedBytes} bytes). Stop Mauxi, back up and review this directory, then manually remove only unneeded captures, completed clean journals, or explicitly chosen conversations. Never delete unfinished recovery records. See docs/private-alpha.md.`);
  }
}

export function writeCapture(file: string, data: Buffer): void {
  assertArtifactCapacity(path.dirname(file), ARTIFACT_LIMITS.captures, data.length, 1);
  writeFileSync(file, data, { flag: "wx", mode: 0o600 });
}
