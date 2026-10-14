import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ARTIFACT_LIMITS, scanArtifacts, writeCapture, type ArtifactBudget, type StorageArtifact } from "./artifact-budget";

export const CAPTURE_RETENTION = {
  previewMaxAgeMs: 24 * 60 * 60 * 1000,
  cleanupIntervalMs: 60 * 60 * 1000,
  targetRatio: 0.75,
};
const uniqueSuffix = "(?:-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?";
const selectionName = new RegExp(`^(desktop|mobile)-selection-[\\w-]{1,128}-\\d+${uniqueSuffix}\\.png$`);
const previewName = new RegExp(`^(desktop|mobile)-\\d+${uniqueSuffix}\\.png$`);

export class CaptureCache {
  readonly root: string;
  private readonly drafts = new Set<string>();
  private readonly readers = new Map<string, number>();

  constructor(root: string, private readonly now = Date.now) { this.root = path.resolve(root); }

  write(previewId: string, data: Buffer, selectionId?: string): string {
    if (!/^(desktop|mobile)$/.test(previewId) || (selectionId !== undefined && !/^[\w-]{1,128}$/.test(selectionId))) throw new Error("Invalid capture identity");
    if (data.length > ARTIFACT_LIMITS.captures.bytes || ARTIFACT_LIMITS.captures.files < 1) throw new Error("Screenshot exceeds the capture storage budget");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.cleanup({ files: 1, bytes: data.length });
    const suffix = selectionId ? `-selection-${selectionId}` : "";
    const file = path.join(this.root, `${previewId}${suffix}-${this.now()}-${randomUUID()}.png`);
    writeCapture(file, data);
    if (selectionId) this.drafts.add(file);
    return file;
  }

  releaseDrafts(files: readonly string[]): void {
    for (const file of files) this.drafts.delete(path.resolve(file));
  }

  clearDrafts(): void { this.drafts.clear(); }

  protectInputs(files: readonly string[]): () => void {
    const resolved = [...new Set(files.map(file => path.resolve(file)))];
    for (const file of resolved) this.readers.set(file, (this.readers.get(file) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const file of resolved) {
        const count = this.readers.get(file)! - 1;
        if (count) this.readers.set(file, count); else this.readers.delete(file);
      }
    };
  }

  cleanup(added: ArtifactBudget = { files: 0, bytes: 0 }): { removedFiles: number; removedBytes: number } {
    const artifacts = scanArtifacts(this.root);
    let files = artifacts.length; let bytes = artifacts.reduce((sum, item) => sum + item.size, 0);
    const removable = artifacts.filter(item => path.dirname(item.file) === this.root
      && (selectionName.test(path.basename(item.file)) || previewName.test(path.basename(item.file)))
      && !this.drafts.has(item.file) && !this.readers.has(item.file))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
    const removed = new Set<string>(); let removedBytes = 0;
    const remove = (item: StorageArtifact) => {
      const info = lstatSync(item.file);
      if (!info.isFile() || info.dev !== item.dev || info.ino !== item.ino || info.size !== item.size || info.mtimeMs !== item.mtimeMs) throw new Error(`Capture changed during cleanup at ${item.file}; preserved for review.`);
      unlinkSync(item.file);
      removed.add(item.file); removedBytes += item.size; files--; bytes -= item.size;
    };
    const now = this.now();
    for (const item of removable) {
      if (selectionName.test(path.basename(item.file)) || now - item.mtimeMs >= CAPTURE_RETENTION.previewMaxAgeMs) remove(item);
    }
    const targetFiles = Math.max(added.files, Math.floor(ARTIFACT_LIMITS.captures.files * CAPTURE_RETENTION.targetRatio));
    const targetBytes = Math.max(added.bytes, Math.floor(ARTIFACT_LIMITS.captures.bytes * CAPTURE_RETENTION.targetRatio));
    for (const item of removable) {
      if (files + added.files <= targetFiles && bytes + added.bytes <= targetBytes) break;
      if (!removed.has(item.file)) remove(item);
    }
    return { removedFiles: removed.size, removedBytes };
  }
}
