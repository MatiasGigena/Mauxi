import { parse } from "@babel/parser";
import type { JSXElement, Node } from "@babel/types";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/schema";

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

const BabelAstNode = Type.Object({ type: Type.String() });

function isAstNode(value: unknown): value is Node {
  return Check(BabelAstNode, value);
}

function jsxLocation(content: string, locator: SourceLocatorHint): { lineNumber: number; columnNumber: number } | null {
  if (!/^[a-z][\w:-]{0,63}$/i.test(locator.tag) || locator.testIds.length > 12) return null;
  const elements: JSXElement[] = [];

  try {
    const pending: Node[] = [parse(content, { sourceType: "unambiguous", plugins: ["jsx", "typescript"] })];

    while (pending.length) {
      const node = pending.pop()!;

      if (node.type === "JSXElement") elements.push(node);

      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (isAstNode(child)) pending.push(child);
        }
      }
    }
  } catch { return null; }

  const candidates = elements.filter(element => element.openingElement.name.type === "JSXIdentifier" && element.openingElement.name.name === locator.tag);
  let matches = candidates;

  if (locator.testIds.length) {
    matches = [];

    for (const testId of locator.testIds) {
      const anchors = elements.filter(element => element.openingElement.attributes.some(attribute => {
        if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "data-testid") return false;
        const value = attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value;

        return value?.type === "StringLiteral" && value.value === testId;
      }));

      if (!anchors.length) continue;

      if (anchors.length !== 1) return null;
      const anchor = anchors[0];
      matches = candidates.filter(element => element.start! >= anchor.start! && element.end! <= anchor.end!);
      break;
    }
  }

  if (matches.length !== 1) return null;
  const location = matches[0].openingElement.loc?.start;

  return location ? { lineNumber: location.line, columnNumber: location.column + 1 } : null;
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

  if (isBasenameOnly || isBundlerUrl) await walk(canonicalRoot);
  const unique = [...new Set(candidates)];
  const valid: string[] = [];

  for (const candidate of unique) {
    try {
      const canonical = await realpath(candidate);

      if (!(canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${path.sep}`))) continue;
      const file = await lstat(canonical);

      if (file.isFile() && !file.isSymbolicLink() && file.size <= 2_097_152) valid.push(canonical);
    } catch {}
  }

  if (valid.length !== 1) return null;
  const content = await readFile(valid[0]);
  const text = content.toString("utf8");

  if (!locator && lineNumber != null && lineNumber > text.split(/\r?\n/).length) return null;
  const mapped = locator ? jsxLocation(text, locator) : null;

  if (locator && !mapped) return null;

  const reportedLocationMatches = Boolean(mapped && lineNumber === mapped.lineNumber && columnNumber != null
    && Math.abs(columnNumber - mapped.columnNumber) <= 1);

  const resolved: ResolvedWorkspaceSource = {
    filePath: path.relative(canonicalRoot, valid[0]).split(path.sep).join("/"),
    fileFingerprint: createHash("sha256").update(content).digest("hex"),
  };

  if (mapped) {
    resolved.lineNumber = mapped.lineNumber;
    resolved.columnNumber = mapped.columnNumber;
    resolved.method = reportedLocationMatches ? "react-grab" : "jsx-attribute";
  }

  return resolved;
}
