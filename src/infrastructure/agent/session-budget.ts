import { existsSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_LIMITS, assertArtifactCapacity } from "../storage/artifact-budget";

const guarded = new WeakSet<SessionManager>();

export function guardSessionStorage(manager: SessionManager, root: string, onFailure: (error: Error) => void): void {
  if (guarded.has(manager)) return;
  guarded.add(manager);
  const persist = manager._persist.bind(manager);
  let failure: Error | undefined;
  manager._persist = entry => {
    if (failure) throw failure;

    if (!manager.isPersisted()) return persist(entry);
    const file = manager.getSessionFile();

    if (!file) throw new Error("Persistent session has no file");

    try {
      const existing = existsSync(file);
      const pending = existing ? [entry] : [manager.getHeader(), ...manager.getEntries()];
      const bytes = pending.reduce((total, value) => total + Buffer.byteLength(`${JSON.stringify(value)}\n`), 0);
      assertArtifactCapacity(root, ARTIFACT_LIMITS.sessions, bytes, existing ? 0 : 1);
      persist(entry);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failure = error;
      onFailure(error);
      throw error;
    }
  };
}
