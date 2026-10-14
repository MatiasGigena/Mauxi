import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { hasErrorCode } from "../error-code";

const ModelPreferenceSchema = Type.Object({ defaultProvider: Type.String(), defaultModel: Type.String() });

type ModelPreference = Static<typeof ModelPreferenceSchema>;

export async function loadModelPreference(profileDir: string): Promise<Partial<ModelPreference>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(profileDir, "model-preference.json"), "utf8"));

    if (Value.Check(ModelPreferenceSchema, value) && value.defaultProvider.trim() && value.defaultModel.trim()) {
      return { defaultProvider: value.defaultProvider, defaultModel: value.defaultModel };
    }

    return {};
  } catch (error) {
    if (error instanceof SyntaxError || (hasErrorCode(error, "ENOENT"))) return {};
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
