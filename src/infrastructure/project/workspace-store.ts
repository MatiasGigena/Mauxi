import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isCanvasState, type CanvasState } from "../../application/canvas-state";

interface RememberedWorkspace {
  version: 1;
  projectRoot: string;
  planId: string;
  confirmedAt: string;
  canvas?: CanvasState;
}

export class WorkspaceStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private fileFor(root: string): string {
    const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    return path.join(this.directory, `${id}.json`);
  }
  private async read(root: string): Promise<RememberedWorkspace | null> {
    try {
      const value = JSON.parse(await readFile(this.fileFor(root), "utf8")) as RememberedWorkspace;
      return value.version === 1 && value.projectRoot === root && typeof value.planId === "string" ? value : null;
    } catch { return null; }
  }
  async rememberedPlan(root: string): Promise<string | null> { return (await this.read(root))?.planId ?? null; }
  async canvas(root: string): Promise<CanvasState | null> {
    const canvas = (await this.read(root))?.canvas;
    return isCanvasState(canvas) ? canvas : null;
  }
  private update(root: string, change: (current: RememberedWorkspace | null) => RememberedWorkspace): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = this.fileFor(root); const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(change(await this.read(root)), null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    });
    this.writes = write;
    return write;
  }
  async remember(root: string, planId: string): Promise<void> {
    return this.update(root, (current) => ({ ...current, version: 1, projectRoot: root, planId, confirmedAt: new Date().toISOString() }));
  }
  async saveCanvas(root: string, canvas: CanvasState): Promise<void> {
    if (!isCanvasState(canvas)) throw new Error("Invalid canvas layout");
    const snapshot = structuredClone(canvas);
    return this.update(root, (current) => {
      if (!current) throw new Error("Workspace has not been confirmed");
      return { ...current, canvas: snapshot };
    });
  }
}
