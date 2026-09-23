import { ARTIFACT_LIMITS, assertArtifactCapacity } from "../storage/artifact-budget";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type TransactionState = "planned" | "applying" | "applied" | "cleaning" | "clean" | "conflicted";

export interface PatchRecord {
  path: string;
  originalHash: string;
  appliedHash: string | null;
  ownedText: string;
  originalContent?: string;
  anchor: string;
  applied: boolean;
  cleaned?: boolean;
}

export interface ArtifactRecord {
  path: string;
  hash: string;
  created: boolean;
}

export interface InstrumentationJournal {
  version: 1;
  transactionId: string;
  workspaceRoot: string;
  framework: "vite" | "next";
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  patches: PatchRecord[];
  artifacts: ArtifactRecord[];
  conflicts: string[];
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class JournalStore {
  constructor(readonly directory: string) {}

  pathFor(transactionId: string): string {
    return path.join(this.directory, `${transactionId}.json`);
  }

  async write(journal: InstrumentationJournal): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (journal.state === "planned") {
      // Reserve room for the bounded config before-image, receipts and atomic
      // staging before touching the project. Recovery writes remain available.
      const existing = (await this.list()).some(item => item.transactionId === journal.transactionId);
      assertArtifactCapacity(this.directory, ARTIFACT_LIMITS.journals, 2 * 1024 * 1024, existing ? 0 : 1);
    }
    const finalPath = this.pathFor(journal.transactionId);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    const next = { ...journal, updatedAt: new Date().toISOString() };
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    const temporary = await open(temporaryPath, "r");
    try { await temporary.sync(); } finally { await temporary.close(); }
    await rename(temporaryPath, finalPath);
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async read(transactionId: string): Promise<InstrumentationJournal> {
    return JSON.parse(await readFile(this.pathFor(transactionId), "utf8")) as InstrumentationJournal;
  }

  async list(): Promise<InstrumentationJournal[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return []; }
    const journals: InstrumentationJournal[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const value = JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as InstrumentationJournal;
        if (value.version === 1 && typeof value.transactionId === "string") journals.push(value);
      } catch (error) {
        throw new Error(`Unreadable recovery record ${path.join(this.directory, name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return journals;
  }
}
