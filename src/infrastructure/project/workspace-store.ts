import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface RememberedWorkspace {
  version: 1;
  projectRoot: string;
  planId: string;
  confirmedAt: string;
}

export class WorkspaceStore {
  constructor(private readonly directory: string) {}

  private fileFor(root: string): string {
    const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    return path.join(this.directory, `${id}.json`);
  }

  async rememberedPlan(root: string): Promise<string | null> {
    try {
      const value = JSON.parse(await readFile(this.fileFor(root), "utf8")) as RememberedWorkspace;
      return value.version === 1 && value.projectRoot === root ? value.planId : null;
    } catch { return null; }
  }

  async remember(root: string, planId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.fileFor(root);
    const temporary = `${file}.${process.pid}.tmp`;
    const value: RememberedWorkspace = { version: 1, projectRoot: root, planId, confirmedAt: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
}
