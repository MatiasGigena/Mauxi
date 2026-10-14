import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface ModelPreference {
  defaultProvider: string;
  defaultModel: string;
}

export async function loadModelPreference(profileDir: string): Promise<Partial<ModelPreference>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(profileDir, "model-preference.json"), "utf8"));

    if (value && typeof value === "object" && "defaultProvider" in value && "defaultModel" in value
      && typeof value.defaultProvider === "string" && value.defaultProvider.trim()
      && typeof value.defaultModel === "string" && value.defaultModel.trim()) {
      return { defaultProvider: value.defaultProvider, defaultModel: value.defaultModel };
    }

    return {};
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveModelPreference(profileDir: string, provider: string, modelId: string): Promise<void> {
  const destination = path.join(profileDir, "model-preference.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, JSON.stringify({ defaultProvider: provider, defaultModel: modelId }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
