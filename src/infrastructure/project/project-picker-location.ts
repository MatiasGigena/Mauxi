import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class ProjectPickerLocation {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async defaultPath(home: string): Promise<string> {
    await this.writes.catch(() => undefined);
    try {
      const saved: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1
        || !("directory" in saved) || typeof saved.directory !== "string" || !path.isAbsolute(saved.directory)) return home;
      if (!(await stat(saved.directory)).isDirectory()) return home;
      await access(saved.directory, constants.R_OK | constants.X_OK);
      return saved.directory;
    } catch { return home; }
  }

  remember(directory: string): Promise<void> {
    if (!path.isAbsolute(directory)) return Promise.reject(new Error("Project picker location must be absolute"));
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, directory })}\n`, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = write;
    return write;
  }
}
