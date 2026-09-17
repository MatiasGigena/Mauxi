import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".mauxi"]);
const MAX_FILES_VISITED = 20_000;

export async function resolveWorkspaceSource(root: string, hint: string): Promise<{ filePath: string; fileFingerprint: string } | null> {
  if (!hint || hint.length > 1_024) throw new Error("Invalid source hint");
  const canonicalRoot = await realpath(root);
  const normalizedHint = hint.replace(/^file:\/\//, "").split(/[?#]/)[0];
  const candidates: string[] = [];
  const absoluteHint = path.isAbsolute(normalizedHint);
  const direct = absoluteHint ? path.resolve(normalizedHint) : path.resolve(canonicalRoot, normalizedHint);
  if (absoluteHint && !(direct === canonicalRoot || direct.startsWith(`${canonicalRoot}${path.sep}`))) return null;
  if (direct === canonicalRoot || direct.startsWith(`${canonicalRoot}${path.sep}`)) candidates.push(direct);

  const basename = path.basename(normalizedHint);
  if (!/^[\w.@()-]+\.(tsx?|jsx?)$/.test(basename)) return null;
  let visited = 0;
  async function walk(directory: string): Promise<void> {
    if (visited >= MAX_FILES_VISITED) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (visited++ >= MAX_FILES_VISITED) return;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name === basename) candidates.push(candidate);
    }
  }
  const isBasenameOnly = normalizedHint === basename;
  if (isBasenameOnly) await walk(canonicalRoot);
  const unique = [...new Set(candidates)];
  const valid: string[] = [];
  for (const candidate of unique) {
    try {
      const canonical = await realpath(candidate);
      if (!(canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`))) continue;
      const file = await lstat(canonical);
      if (file.isFile() && !file.isSymbolicLink() && file.size <= 2_097_152) valid.push(canonical);
    } catch { /* stale hint */ }
  }
  if (valid.length !== 1) return null;
  const content = await readFile(valid[0]);
  return {
    filePath: path.relative(canonicalRoot, valid[0]).split(path.sep).join("/"),
    fileFingerprint: createHash("sha256").update(content).digest("hex"),
  };
}
