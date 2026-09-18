import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".mauxi"]);
const MAX_FILES_VISITED = 20_000;

export interface SourceLocatorHint { tag: string; testIds: string[] }
export interface ResolvedWorkspaceSource {
  filePath: string;
  fileFingerprint: string;
  lineNumber?: number;
  columnNumber?: number;
  method?: "react-grab" | "jsx-attribute";
}

function jsxLocation(content: string, locator: SourceLocatorHint): { lineNumber: number; columnNumber: number } | null {
  if (!/^[a-z][\w:-]{0,63}$/i.test(locator.tag) || locator.testIds.length > 12) return null;
  const tagPattern = new RegExp(`<${locator.tag}(?=[\\s/>])`, "gi");
  const tagOffsets = [...content.matchAll(tagPattern)].map((match) => match.index!);
  let offset: number | null = null;
  if (!locator.testIds.length) {
    // A tag alone identifies JSX only when it occurs exactly once in the file.
    if (tagOffsets.length !== 1) return null;
    offset = tagOffsets[0];
  } else {
    const candidates: Array<{ offset: number; distance: number }> = [];
    for (const testId of locator.testIds) {
      if (!testId || testId.length > 512) continue;
      const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const attribute = new RegExp(`data-testid\\s*=\\s*(["'])${escaped}\\1`, "g");
      const anchors = [...content.matchAll(attribute)].map((match) => match.index!);
      if (anchors.length !== 1) continue;
      for (const tagOffset of tagOffsets) {
        const distance = Math.abs(tagOffset - anchors[0]);
        if (distance <= 2_000) candidates.push({ offset: tagOffset, distance });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.distance - b.distance);
    if (candidates[1] && candidates[1].distance === candidates[0].distance && candidates[1].offset !== candidates[0].offset) return null;
    offset = candidates[0].offset;
  }
  const before = content.slice(0, offset);
  const lineNumber = before.split(/\r?\n/).length;
  const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  return { lineNumber, columnNumber: offset - lastBreak };
}

export async function resolveWorkspaceSource(
  root: string,
  hint: string,
  lineNumber?: number | null,
  columnNumber?: number | null,
  locator?: SourceLocatorHint,
): Promise<ResolvedWorkspaceSource | null> {
  if (!hint || hint.length > 1_024) throw new Error("Invalid source hint");
  if (lineNumber != null && (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > 1_000_000)) throw new Error("Invalid source line");
  if (columnNumber != null && (!Number.isInteger(columnNumber) || columnNumber < 0 || columnNumber > 1_000_000)) throw new Error("Invalid source column");
  const canonicalRoot = await realpath(root);
  const normalizedHint = hint.replace(/^file:\/\//, "").split(/[?#]/)[0];
  const candidates: string[] = [];
  const absoluteHint = path.isAbsolute(normalizedHint);
  const virtualProjectPath = /^\/(?:src|app|pages|components)\//.test(normalizedHint);
  const direct = virtualProjectPath ? path.resolve(canonicalRoot, normalizedHint.slice(1)) : absoluteHint ? path.resolve(normalizedHint) : path.resolve(canonicalRoot, normalizedHint);
  if (absoluteHint && !virtualProjectPath && !(direct === canonicalRoot || direct.startsWith(`${canonicalRoot}${path.sep}`))) return null;
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
  const isBundlerUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(normalizedHint);
  // Bundler URLs are not filesystem authority. Resolve only their basename and
  // accept it when the workspace contains exactly one matching source file.
  if (isBasenameOnly || isBundlerUrl) await walk(canonicalRoot);
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
  const text = content.toString("utf8");
  if (!locator && lineNumber != null && lineNumber > text.split(/\r?\n/).length) return null;
  const mapped = locator ? jsxLocation(text, locator) : null;
  if (locator && !mapped) return null;
  const reportedLocationMatches = Boolean(mapped && lineNumber === mapped.lineNumber && columnNumber != null
    && Math.abs(columnNumber - mapped.columnNumber) <= 1);
  return {
    filePath: path.relative(canonicalRoot, valid[0]).split(path.sep).join("/"),
    fileFingerprint: createHash("sha256").update(content).digest("hex"),
    ...(mapped ? { ...mapped, method: reportedLocationMatches ? "react-grab" as const : "jsx-attribute" as const } : {}),
  };
}
