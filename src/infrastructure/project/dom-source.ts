import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export async function inspectDomSource(root: string, tag: string, testId: string, signal: AbortSignal) {
  const unavailable = { status: "unverified", reason: "No unique bounded static JSX match. Pick the element for React Grab provenance or inspect project source; do not invent a mapping." };
  if (!/^[a-z][\w:-]{0,63}$/i.test(tag) || !testId || testId.length > 512) return unavailable;
  const canonical = await realpath(root);
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${tag}\\b[^>]{0,2000}\\bdata-testid\\s*=\\s*(["'])${escaped}\\1[^>]{0,2000}>`, "g");
  const matches: Array<{ filePath: string; fileFingerprint: string; lineNumber: number; excerpt: string }> = [];
  let visited = 0, bytes = 0, bounded = false;
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (++visited > 1000 || bytes >= 4 * 1024 * 1024) { bounded = true; return; }
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(filename); if (bounded || matches.length > 1) return; continue; }
      if (!entry.isFile() || !/\.[jt]sx?$/.test(entry.name)) continue;
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
      if (!handle) continue;
      try {
        const actual = await realpath(`/proc/self/fd/${handle.fd}`);
        if (!actual.startsWith(canonical + path.sep)) continue;
        const info = await handle.stat(); if (!info.isFile() || info.size > 512 * 1024) { bounded = true; continue; }
        bytes += info.size;
        const content = await handle.readFile("utf8");
        for (const match of content.matchAll(pattern)) {
          matches.push({ filePath: path.relative(canonical, actual), fileFingerprint: createHash("sha256").update(content).digest("hex"), lineNumber: content.slice(0, match.index).split("\n").length, excerpt: content.slice(Math.max(0, match.index! - 200), match.index! + 1800) });
          if (matches.length > 1) return;
        }
      } finally { await handle.close(); }
    }
  };
  await walk(canonical);
  return matches.length === 1 && !bounded
    ? { status: "static-match", ...matches[0], note: "Host-verified workspace file and unique literal JSX test ID. This is a source candidate, not verified runtime component ownership." }
    : unavailable;
}
