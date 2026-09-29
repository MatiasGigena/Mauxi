import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyDesignRequest } from "../../src/application/design-guidance";
import { DesignResources } from "../../src/infrastructure/agent/design-resources";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-resources-")); roots.push(root);
  const resources = new DesignResources(path.join(root, "profile")); await resources.initialize();
  const source = path.join(root, "source"); await mkdir(source);
  return { root, resources, source };
}
async function skill(source: string, name = "apple-design", body = "Preserve project conventions.") {
  const file = path.join(source, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: UI guidance\ndisable-model-invocation: true\n---\n${body}`); return file;
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function catalog(source: string) {
  const bytes = Buffer.from("RIFF0000WEBPtest"); await mkdir(path.join(source, "images"));
  await writeFile(path.join(source, "images", "pricing.webp"), bytes);
  const entry = { id: "calm-pricing", family: "pricing", cue: "Quiet subscription tiers", source: "https://example.com", tags: ["light", "serif"], reviewStatus: "reviewed", imagePath: "images/pricing.webp", mobileImagePath: "images/pricing.webp", sha256: { imagePath: digest(bytes), mobileImagePath: digest(bytes) } };
  const file = path.join(source, "catalog.json"); await writeFile(file, JSON.stringify({ version: 1, references: [entry] })); return { file, entry };
}
describe("reviewed local design resources", () => {
  it("uses native skills, copies only approved Markdown, leaves manual originals untouched, and persists enablement", async () => {
    const { source, resources, root } = await setup();
    const file = await skill(source, "prototype", "See [picker](PICKER.md). Only runs when explicitly invoked; it does not trigger on its own.");
    await writeFile(path.join(source, "PICKER.md"), "Picker behavior");
    const before = await readFile(file, "utf8"); const prepared = await resources.prepareSkill(file);
    expect(prepared.content["SKILL.md"]).not.toContain("disable-model-invocation");
    await resources.importSkill(prepared);
    expect(resources.loadedSkills[0].disableModelInvocation).toBe(false);
    expect(await resources.readSkill("prototype", "PICKER.md")).toBe("Picker behavior");
    expect(await resources.guidance("Show three variants")).toContain("Picker behavior");
    const explicit = await resources.guidance("/skill:prototype show options");
    expect(explicit).toContain("Guidance: prototype");
    expect(explicit).toContain("Picker behavior");
    expect(await readFile(file, "utf8")).toBe(before);
    await expect(resources.prepareSkill(file)).rejects.toThrow(/already imported/);
    await resources.setEnabled("prototype", false);
    expect(await resources.guidance("Show variants")).toBe("");
    await expect(resources.guidance("/prototype show options")).rejects.toThrow(/unavailable/);
    const reopened = new DesignResources(path.join(root, "profile")); await reopened.initialize();
    expect(reopened.snapshot().skills[0].enabled).toBe(false);
  });
  it("automatically includes transitive Markdown once, including circular links", async () => {
    const { resources, source } = await setup();
    await mkdir(path.join(source, "details"));
    const file = await skill(source, "prototype", "See [picker](PICKER.md). Also [details](details/BEHAVIOR.md).");
    await writeFile(path.join(source, "PICKER.md"), "PICKER_CONTENT_UNIQUE: use the exact picker. See [behavior](details/BEHAVIOR.md).");
    await writeFile(path.join(source, "details/BEHAVIOR.md"), "BEHAVIOR_CONTENT_UNIQUE: keyboard switching. See [skill](../SKILL.md).");
    await resources.importSkill(await resources.prepareSkill(file));
    const guidance = await resources.guidance("Show variants");
    expect(guidance.match(/PICKER_CONTENT_UNIQUE/g)).toHaveLength(1);
    expect(guidance.match(/BEHAVIOR_CONTENT_UNIQUE/g)).toHaveLength(1);
    expect(guidance).toContain("File: details/BEHAVIOR.md");
    expect(guidance.indexOf("File: SKILL.md")).toBeLessThan(guidance.indexOf("File: PICKER.md"));
  });
  it("refuses automatic guidance if a copied dependency changes after loading", async () => {
    const { resources, source } = await setup();
    const file = await skill(source, "prototype", "See [picker](PICKER.md).");
    await writeFile(path.join(source, "PICKER.md"), "Approved picker");
    await resources.importSkill(await resources.prepareSkill(file));
    const directory = path.dirname(resources.loadedSkills[0].filePath);
    await writeFile(path.join(directory, "PICKER.md"), "Changed picker");
    await expect(resources.guidance("Show variants")).rejects.toThrow(/changed since approval/);
  });
  it("bounds aggregate guidance bytes across skills and never silently omits dependencies", async () => {
    const { resources, source } = await setup();
    for (const name of ["apple-design", "prototype"]) {
      const directory = path.join(source, name); await mkdir(directory);
      const file = await skill(directory, name, `${"a".repeat(60_000)}\nSee [details](DETAILS.md).`);
      await writeFile(path.join(directory, "DETAILS.md"), "é".repeat(50_000));
      await resources.importSkill(await resources.prepareSkill(file));
    }
    await expect(resources.guidance("Show UI variants")).rejects.toThrow(/guidance.*budget/i);
    await resources.setEnabled("prototype", false);
    const guidance = await resources.guidance("Improve UI");
    expect(guidance).toContain("é".repeat(50_000));
    expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(300_000);
  });
  it("rejects unknown executable imports, malformed skills, escaping dependencies, and symlinks", async () => {
    const { resources, source, root } = await setup();
    await expect(resources.prepareSkill("npm:unsafe")).rejects.toThrow(/unsupported/);
    await expect(resources.prepareSkill(await skill(source, "unknown"))).rejects.toThrow(/reviewed initial pack/);
    await expect(resources.prepareSkill(await skill(source, "apple-design", "[escape](../outside.md)"))).rejects.toThrow(/escapes/);
    await writeFile(path.join(root, "outside.md"), "private");
    await symlink(path.join(root, "outside.md"), path.join(source, "link.md"));
    await expect(resources.prepareSkill(await skill(source, "apple-design", "[escape](link.md)"))).rejects.toThrow(/escapes/);
    const file = await skill(source); await writeFile(file, "not a skill");
    await expect(resources.prepareSkill(file)).rejects.toThrow(/Invalid skill/);
  });
  it("fails closed on changed imported content and corrupt configuration", async () => {
    const { resources, source, root } = await setup();
    await resources.importSkill(await resources.prepareSkill(await skill(source)));
    const file = resources.loadedSkills[0].filePath; await writeFile(file, "tampered");
    await expect(resources.readSkill("apple-design")).rejects.toThrow(/changed/);
    await resources.reload(); expect(resources.snapshot().skills[0].loaded).toBe(false);
    await writeFile(path.join(root, "profile", "resources.json"), "broken");
    const reopened = new DesignResources(path.join(root, "profile")); await reopened.initialize();
    expect(reopened.snapshot().diagnostics.join()).toContain("could not be loaded");
  });
  it("ranks matching families/styles, attaches verified bytes, rejects stale catalogs and images", async () => {
    const { resources, source } = await setup(); const { file } = await catalog(source);
    await resources.importCatalog(await resources.prepareCatalog(file));
    expect(resources.search("light subscription plans", "mobile")[0].id).toBe("calm-pricing");
    expect(resources.search("unmatched phrase")).toEqual([]);
    expect((await resources.image("calm-pricing", "mobile", true)).mimeType).toBe("image/webp");
    await expect(resources.image("calm-pricing", "mobile", false)).rejects.toThrow(/cannot inspect/);
    await writeFile(path.join(source, "images/pricing.webp"), "tampered");
    await expect(resources.image("calm-pricing", "mobile", true)).rejects.toThrow(/invalid or changed/);
    await writeFile(file, "{}"); await resources.reload();
    expect(resources.snapshot().catalog?.error).toContain("Catalog changed");
    expect(() => resources.search("pricing")).toThrow(/unavailable/);
  });
  it("does not promote a relabeled candidate until the changed catalog is reapproved", async () => {
    const { resources, source } = await setup(); const { file, entry } = await catalog(source);
    const next = { ...entry, id: "new-pricing", reviewStatus: "candidate" };
    await writeFile(file, JSON.stringify({ version: 1, references: [entry, next] }));
    await resources.importCatalog(await resources.prepareCatalog(file));
    expect(resources.search("pricing").map((item) => item.id)).toEqual([entry.id]);
    next.reviewStatus = "reviewed";
    await writeFile(file, JSON.stringify({ version: 1, references: [entry, next] }));
    await resources.prepareCatalog(file); // Preparing is not an approval or activation.
    expect(resources.search("pricing").map((item) => item.id)).toEqual([entry.id]);
    await resources.reload();
    expect(() => resources.search("pricing")).toThrow(/unavailable/);
    expect(resources.snapshot().catalog?.error).toContain("Catalog changed");
    // importCatalog is called by the host only after explicit approval of this digest.
    await resources.importCatalog(await resources.prepareCatalog(file));
    expect(resources.search("pricing").map((item) => item.id)).toEqual([entry.id, next.id]);
  });
  it("rejects traversal, duplicate catalogs and changed approval bytes", async () => {
    const { resources, source } = await setup(); const { file, entry } = await catalog(source);
    const prepared = await resources.prepareCatalog(file); await writeFile(file, "{}");
    await expect(resources.importCatalog(prepared)).rejects.toThrow(/changed during approval/);
    await writeFile(file, JSON.stringify({ version: 1, references: [entry, entry] }));
    await expect(resources.prepareCatalog(file)).rejects.toThrow(/duplicate/);
    await writeFile(file, JSON.stringify({ version: 1, references: [{ ...entry, imagePath: "../private.webp" }] }));
    await expect(resources.prepareCatalog(file)).rejects.toThrow(/path/);
  });
  it("loads built-in references on a fresh profile without imports and verifies every reviewed image", async () => {
    const { root } = await setup();
    const file = path.resolve("design-references/library/catalog.json");
    const directory = path.join(root, "fresh-profile");
    const resources = new DesignResources(directory, file);
    await resources.initialize();
    expect(resources.snapshot().catalog).toMatchObject({ path: file, count: 10, enabled: true });
    expect(resources.search("light serif hero", "mobile").length).toBeGreaterThan(0);
    const entries = JSON.parse(await readFile(file, "utf8")).references;
    for (const entry of entries.filter((item: { reviewStatus: string }) => item.reviewStatus === "reviewed")) {
      expect((await resources.image(entry.id, "desktop", true)).data.length).toBeGreaterThan(100);
      if (entry.mobileImagePath) expect((await resources.image(entry.id, "mobile", true)).data.length).toBeGreaterThan(100);
    }
    await expect(readFile(path.join(directory, "resources.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = new DesignResources(directory, file); await reopened.initialize();
    expect(reopened.search("light serif hero", "mobile")).toEqual(resources.search("light serif hero", "mobile"));
  });
  it("preserves an approved library and its disabled state instead of replacing it with built-ins", async () => {
    const { root, resources, source } = await setup();
    const { file } = await catalog(source);
    await resources.importCatalog(await resources.prepareCatalog(file));
    const directory = path.join(root, "profile");
    const bundled = path.resolve("design-references/library/catalog.json");
    const reopened = new DesignResources(directory, bundled); await reopened.initialize();
    expect(reopened.search("pricing")[0].id).toBe("calm-pricing");
    await reopened.setEnabled("catalog", false);
    const disabled = new DesignResources(directory, bundled); await disabled.initialize();
    expect(disabled.snapshot().catalog).toMatchObject({ path: file, enabled: false });
    expect(() => disabled.search("hero")).toThrow(/unavailable/);
  });
  it("does not bypass corrupt private configuration or silently accept missing built-ins", async () => {
    const { root } = await setup();
    const directory = path.join(root, "profile");
    await writeFile(path.join(directory, "resources.json"), "broken");
    const corrupt = new DesignResources(directory, path.resolve("design-references/library/catalog.json"));
    await corrupt.initialize();
    expect(() => corrupt.search("hero")).toThrow(/configuration could not be loaded/);
    const missing = new DesignResources(path.join(root, "missing-profile"), path.join(root, "catalog.json"));
    await missing.initialize();
    expect(() => missing.search("hero")).toThrow(/Bundled visual library could not be loaded/);
  });
  it("retrieves the actual reviewed repository catalog without reading unindexed directions", async () => {
    const { resources } = await setup();
    await resources.importCatalog(await resources.prepareCatalog(path.resolve("design-references/library/catalog.json")));
    expect(resources.snapshot().catalog!.count).toBe(10);
    expect(resources.search("light serif pricing", "mobile")).toEqual([]); // no reviewed pricing family; do not substitute an unrelated hero
    const result = resources.search("light serif hero", "mobile");
    expect(result[0].family).toBe("hero");
    expect((await resources.image(result[0].id, "mobile", true)).data.length).toBeGreaterThan(100);
  });
});
describe("request classification", () => {
  it.each([
    ["Improve responsive layout on phone", ["apple-design", "mobile-native"]],
    ["Polish hover animation with reduced-motion", ["apple-design", "emil-design-eng"]],
    ["Show three pricing variants", ["apple-design", "prototype"]],
    ["Fix database query", []],
    ["Mejorar diseño móvil", ["apple-design", "mobile-native"]],
  ])("routes %s", (text, names) => { expect(classifyDesignRequest(text as string)).toEqual(names); });
});
