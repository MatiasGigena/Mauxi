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

it("maps nested JSX within its anchor, never a nearby sibling, comment or string", async () => {
  const { resolveWorkspaceSource } = await import("../../src/infrastructure/project/source-resolver");
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-jsx-source-"));
  try {
    const source = `const decoy = '<span data-testid="button">not JSX</span>';
export const Card = () => <article><span>Badge</span>
  <button data-testid="button" title={">"} onClick={() => true}><span>Actual text</span></button>
</article>;`;
    await writeFile(path.join(root, "Card.tsx"), source);
    const anchor = '<span>Actual text';
    const offset = source.indexOf(anchor); const prefix = source.slice(0, offset);
    expect(await resolveWorkspaceSource(root, "Card.tsx", 2, 35, { tag: "span", testIds: ["button"] })).toMatchObject({ lineNumber: 3, columnNumber: offset - prefix.lastIndexOf("\n"), method: "jsx-attribute" });
    await writeFile(path.join(root, "Card.tsx"), '<button data-testid="button"><span>First</span><span>Second</span></button>');
    expect(await resolveWorkspaceSource(root, "Card.tsx", 1, 29, { tag: "span", testIds: ["button"] })).toBeNull();
    await writeFile(path.join(root, "Card.tsx"), '<><span data-testid="same" /><span data-testid="same" /></>');
    expect(await resolveWorkspaceSource(root, "Card.tsx", 1, 3, { tag: "span", testIds: ["same"] })).toBeNull();
    await writeFile(path.join(root, "Card.tsx"), '<button data-testid="button">unfinished');
    expect(await resolveWorkspaceSource(root, "Card.tsx", 1, 1, { tag: "button", testIds: ["button"] })).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
