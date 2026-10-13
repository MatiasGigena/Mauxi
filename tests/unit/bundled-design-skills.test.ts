import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DESIGN_SKILLS } from "../../src/application/design-guidance";
import { DesignResources } from "../../src/infrastructure/agent/design-resources";

const roots: string[] = [];
const bundle = path.resolve("design-skills");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mauxi-bundled-skills-")); roots.push(root);
  const profile = path.join(root, "profile");
  const resources = new DesignResources(profile, undefined, bundle);
  await resources.initialize();
  return { root, profile, resources };
}

describe("bundled design guidance", () => {
  it("loads all four original skills and the picker on a fresh profile without writing configuration", async () => {
    const { resources, profile } = await setup();
    expect(resources.loadedSkills.map((skill) => skill.name).sort()).toEqual([...DESIGN_SKILLS].sort());
    expect(resources.snapshot().skills.every((skill) => skill.loaded && skill.enabled && !skill.error)).toBe(true);
    expect(resources.loadedSkills.every((skill) => !skill.disableModelInvocation)).toBe(true);
    for (const name of DESIGN_SKILLS) {
      expect(await resources.readSkill(name)).toBe(await readFile(path.join(bundle, name, "SKILL.md"), "utf8"));
    }
    const picker = await readFile(path.join(bundle, "prototype/PICKER.md"), "utf8");
    expect(await resources.readSkill("prototype", "PICKER.md")).toBe(picker);
    const guidance = await resources.guidance("I need you to give me 3 variants of this header.");
    expect(guidance).toContain("Guidance: apple-design");
    expect(guidance).toContain("Guidance: prototype");
    expect(guidance).toContain(picker);
    expect(guidance.match(/File: PICKER.md/g)).toHaveLength(1);
    expect(await resources.guidance("Polish responsive UI variants", true)).toContain("Guidance: emil-design-eng");
    expect(await resources.guidance("Fix database query")).toBe("");
    await expect(readFile(path.join(profile, "resources.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists bundled enablement without creating personal copies and rejects invalid settings", async () => {
    const { resources, profile } = await setup();
    await resources.setEnabled("prototype", false);
    const reopen = new DesignResources(profile, undefined, bundle); await reopen.initialize();
    expect(reopen.loadedSkills).toHaveLength(3);
    await expect(reopen.readSkill("prototype")).rejects.toThrow(/unavailable or disabled/);
    await expect(reopen.guidance("/prototype show options")).rejects.toThrow(/unavailable/);
    expect(await reopen.guidance("Show variants")).toBe("");
    expect(JSON.parse(await readFile(path.join(profile, "resources.json"), "utf8"))).toMatchObject({ skills: [], bundledSkillEnabled: { prototype: false } });
    await reopen.setEnabled("prototype", true);
    expect(reopen.loadedSkills).toHaveLength(4);
    await writeFile(path.join(profile, "resources.json"), JSON.stringify({ version: 1, skills: [], bundledSkillEnabled: { prototype: "yes" } }));
    const invalid = new DesignResources(profile, undefined, bundle); await invalid.initialize();
    expect(invalid.loadedSkills).toEqual([]);
    expect(invalid.snapshot().diagnostics.join()).toContain("could not be loaded");
  });

  it("keeps approved personal overrides, their disabled state and validation failures ahead of the bundle", async () => {
    const { resources, profile, root } = await setup();
    const source = path.join(root, "source"); await mkdir(source);
    const file = path.join(source, "SKILL.md");
    await writeFile(file, "---\nname: prototype\ndescription: Personal variants\n---\nPERSONAL_VARIANTS");
    await resources.importSkill(await resources.prepareSkill(file));
    expect(await resources.readSkill("prototype")).toContain("PERSONAL_VARIANTS");
    expect(resources.loadedSkills).toHaveLength(4);
    await resources.setEnabled("prototype", false);
    const reopen = new DesignResources(profile, undefined, bundle); await reopen.initialize();
    await expect(reopen.readSkill("prototype")).rejects.toThrow(/unavailable/);
    await reopen.setEnabled("prototype", true);
    const imported = reopen.loadedSkills.find((skill) => skill.name === "prototype")!;
    await writeFile(imported.filePath, "changed");
    await reopen.reload();
    expect(reopen.snapshot().skills.find((skill) => skill.name === "prototype")).toMatchObject({ loaded: false });
    await expect(reopen.readSkill("prototype")).rejects.toThrow(/unavailable/);
    expect(reopen.loadedSkills).toHaveLength(3);
  });

  it("loads from the packaged resource layout independently of cwd and fails closed on altered dependencies", async () => {
    const { profile, root } = await setup();
    const config = JSON.parse(await readFile("package.json", "utf8"));
    const packaging = config.build.extraResources.find((item: { from: string }) => item.from === "design-skills");
    expect(packaging).toEqual({ from: "design-skills", to: "design-skills", filter: ["**/*.md"] });
    const installed = path.join(root, "application/resources", packaging.to);
    await cp(bundle, installed, { recursive: true });
    const resources = new DesignResources(profile, undefined, installed); await resources.initialize();
    expect(resources.loadedSkills).toHaveLength(4);
    expect(resources.loadedSkills.every((skill) => skill.filePath.startsWith(installed))).toBe(true);
    await writeFile(path.join(installed, "prototype/PICKER.md"), "UNREVIEWED");
    await expect(resources.guidance("Show header variants")).rejects.toThrow(/changed since approval/);
    await resources.reload();
    expect(resources.snapshot().skills.find((skill) => skill.name === "prototype")).toMatchObject({ loaded: false });
    await expect(resources.readSkill("prototype")).rejects.toThrow(/unavailable/);
    await rm(path.join(installed, "apple-design/SKILL.md"));
    const reopen = new DesignResources(profile, undefined, installed); await reopen.initialize();
    expect(reopen.loadedSkills.map((skill) => skill.name).sort()).toEqual(["emil-design-eng", "mobile-native"]);
  });

  it("never bypasses corrupt private configuration with bundled skills", async () => {
    const { profile } = await setup();
    await writeFile(path.join(profile, "resources.json"), "broken");
    const resources = new DesignResources(profile, undefined, bundle); await resources.initialize();
    expect(resources.loadedSkills).toEqual([]);
    await expect(resources.readSkill("prototype")).rejects.toThrow(/unavailable/);
    expect(resources.snapshot().diagnostics.join()).toContain("could not be loaded");
  });
});
