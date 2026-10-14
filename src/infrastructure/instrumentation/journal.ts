import { ARTIFACT_LIMITS, assertArtifactCapacity } from "../storage/artifact-budget";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type TransactionState = "planned" | "applying" | "applied" | "cleaning" | "clean" | "conflicted";

export interface PatchRecord {
  path: string;
  originalHash: string;
  appliedHash: string | null;
  ownedText: string;
  originalContent?: string;
  anchor: string;
  applied: boolean;
  writeStarted?: boolean;
  cleanupBeforeHash?: string;
  cleanupAfterHash?: string;
  cleaned?: boolean;
  ownedParts?: string[];
}

export interface ArtifactRecord {
  path: string;
  hash: string;
  created: boolean;
  written?: boolean;
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
  runtime?: { path: string; token: string; created: boolean; cleaned?: boolean };
  generatedTypes?: { path: string; before: string | null; cleanupBefore?: string; cleanupAfter?: string; cleaned?: boolean };
}

const PatchRecordSchema = Type.Object({
  path: Type.String(),
  originalHash: Type.String(),
  appliedHash: Type.Union([Type.String(), Type.Null()]),
  ownedText: Type.String(),
  originalContent: Type.Optional(Type.String()),
  anchor: Type.String(),
  applied: Type.Boolean(),
  writeStarted: Type.Optional(Type.Boolean()),
  cleanupBeforeHash: Type.Optional(Type.String()),
  cleanupAfterHash: Type.Optional(Type.String()),
  cleaned: Type.Optional(Type.Boolean()),
  ownedParts: Type.Optional(Type.Array(Type.String())),
});

const JournalSchema = Type.Object({
  version: Type.Literal(1),
  transactionId: Type.String(),
  workspaceRoot: Type.String(),
  framework: Type.Union([Type.Literal("vite"), Type.Literal("next")]),
  state: Type.Union([Type.Literal("planned"), Type.Literal("applying"), Type.Literal("applied"), Type.Literal("cleaning"), Type.Literal("clean"), Type.Literal("conflicted")]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  patches: Type.Array(PatchRecordSchema),
  artifacts: Type.Array(Type.Object({ path: Type.String(), hash: Type.String(), created: Type.Boolean(), written: Type.Optional(Type.Boolean()) })),
  conflicts: Type.Array(Type.String()),
  runtime: Type.Optional(Type.Object({ path: Type.String(), token: Type.String(), created: Type.Boolean(), cleaned: Type.Optional(Type.Boolean()) })),
  generatedTypes: Type.Optional(Type.Object({
    path: Type.String(),
    before: Type.Union([Type.String(), Type.Null()]),
    cleanupBefore: Type.Optional(Type.String()),
    cleanupAfter: Type.Optional(Type.String()),
    cleaned: Type.Optional(Type.Boolean()),
  })),
});

const JournalIdentitySchema = Type.Object({ version: Type.Literal(1), transactionId: Type.String() });

async function readJournal(file: string): Promise<InstrumentationJournal | undefined> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));

  if (!Value.Check(JournalIdentitySchema, value)) return undefined;

  if (!Value.Check(JournalSchema, value)) throw new Error(`Invalid recovery record ${file}`);

  return value;
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
    const file = this.pathFor(transactionId);
    const journal = await readJournal(file);

    if (!journal) throw new Error(`Invalid recovery record ${file}`);

    return journal;
  }

  async list(): Promise<InstrumentationJournal[]> {
    let names: string[];

    try { names = await readdir(this.directory); } catch { return []; }

    const journals: InstrumentationJournal[] = [];

    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const journal = await readJournal(path.join(this.directory, name));

        if (journal) journals.push(journal);
      } catch (error) {
        throw new Error(`Unreadable recovery record ${path.join(this.directory, name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return journals;
  }
}
