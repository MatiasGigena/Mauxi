import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { inspectDomSource } from "../../src/infrastructure/project/dom-source";

it("returns bounded static source candidates, not invented runtime provenance or escaping files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mauxi-dom-source-"));
  const root = path.join(temp, "project"); await mkdir(root);
  const signal = new AbortController().signal;
  try {
    await writeFile(path.join(root, "Card.tsx"), 'export const Card = () => <button data-testid="known">Test</button>;');
    const result = await inspectDomSource(root, "button", "known", signal);
    expect(result).toMatchObject({ status: "static-match", filePath: "Card.tsx", lineNumber: 1 });
    expect(JSON.stringify(result)).toContain("not verified runtime");
    await writeFile(path.join(root, "Duplicate.tsx"), '<button data-testid="known">Duplicate</button>');
    expect(await inspectDomSource(root, "button", "known", signal)).toMatchObject({ status: "unverified" });
    await writeFile(path.join(temp, "Secret.tsx"), '<button data-testid="outside">secret</button>');
    await symlink(path.join(temp, "Secret.tsx"), path.join(root, "Link.tsx"));
    expect(await inspectDomSource(root, "button", "outside", signal)).toMatchObject({ status: "unverified" });
    expect(await inspectDomSource(root, "button", "", signal)).toMatchObject({ status: "unverified" });
    await expect(inspectDomSource(root, "button", "known", AbortSignal.abort())).rejects.toThrow();
  } finally { await rm(temp, { recursive: true, force: true }); }
});
