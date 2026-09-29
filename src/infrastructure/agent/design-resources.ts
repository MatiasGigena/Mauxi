import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import { DESIGN_SKILLS, classifyDesignRequest, GUIDANCE_MARKER } from "../../application/design-guidance";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const MAX_MARKDOWN = 120_000;
import type { ResourceView, SkillRecord } from "../../application/design-resource-contract";
export interface ResourceState { version: 1; skills: SkillRecord[]; catalog?: { path: string; digest: string; enabled: boolean }; }
export interface Reference {
  id: string; family: string; tags: string[]; cue: string; source: string;
  imagePath: string; mobileImagePath?: string; pairEvidence?: string;
  sha256: { imagePath: string; mobileImagePath?: string };
}
export interface PreparedSkill { record: SkillRecord; content: Record<string, string>; }

/** Bounded descriptor reads, canonical containment, no final symlink. Not an OS sandbox. */
async function boundedFile(file: string, maximum: number, root?: string): Promise<Buffer> {
  const canonical = await realpath(file);
  if (root) {
    const relative = path.relative(await realpath(root), canonical);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Resource path escapes its approved directory.");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error("Resource is not a bounded regular file.");
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== canonical) throw new Error("Resource changed during read.");
    const buffer = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maximum) throw new Error("Resource exceeds its size limit.");
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}
function relativeMarkdown(file: string): boolean {
  return /^[\w./-]+\.md$/i.test(file) && !path.isAbsolute(file) && !file.split("/").includes("..");
}
function validRecord(value: SkillRecord): boolean {
  return !!value && DESIGN_SKILLS.includes(value.name as typeof DESIGN_SKILLS[number]) && typeof value.source === "string"
    && /^[a-f0-9]{64}$/.test(value.digest) && typeof value.enabled === "boolean" && !!value.files && typeof value.files === "object"
    && Object.keys(value.files).length <= 16 && !!value.files["SKILL.md"]
    && Object.entries(value.files).every(([file, digest]) => relativeMarkdown(file) && /^[a-f0-9]{64}$/.test(digest));
}

export class DesignResources {
  private state: ResourceState = { version: 1, skills: [] };
  private skills: Skill[] = [];
  private view: ResourceView = { skills: [], diagnostics: [], tools: ["design_read", "design_search", "design_image"] };
  private references: Reference[] = [];
  private configError?: string;
  private bundledCatalog?: ResourceState["catalog"];
  private bundledCatalogError?: string;
  constructor(readonly directory: string, private readonly bundledCatalogPath?: string) {}
  private get catalog(): ResourceState["catalog"] { return this.state.catalog ?? this.bundledCatalog; }
  private skillDirectory(record: SkillRecord): string { return path.join(this.directory, "skills", record.name, record.digest); }
  get loadedSkills(): Skill[] { return [...this.skills]; }
  snapshot(): ResourceView { return structuredClone(this.view); }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const candidate = JSON.parse((await boundedFile(path.join(this.directory, "resources.json"), 100_000)).toString()) as ResourceState;
      if (candidate.version !== 1 || !Array.isArray(candidate.skills) || candidate.skills.length > 4 || !candidate.skills.every(validRecord)
        || new Set(candidate.skills.map((skill) => skill.name)).size !== candidate.skills.length
        || (candidate.catalog && (typeof candidate.catalog.path !== "string" || !path.isAbsolute(candidate.catalog.path) || !/^[a-f0-9]{64}$/.test(candidate.catalog.digest) || typeof candidate.catalog.enabled !== "boolean"))) throw new Error("Invalid resource configuration.");
      this.state = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.configError = `Resource configuration could not be loaded. Repair resources.json before importing: ${String(error)}`;
    }
    // App-owned references need no setup. Never replace an approved catalog,
    // override its disabled state, or bypass a corrupt private configuration.
    if (!this.configError && !this.state.catalog && this.bundledCatalogPath) {
      try { this.bundledCatalog = await this.prepareCatalog(this.bundledCatalogPath); }
      catch (error) { this.bundledCatalogError = `Bundled visual library could not be loaded: ${String(error)}`; }
    }
    await this.reload();
  }
  private async save(next: ResourceState): Promise<void> {
    if (this.configError) throw new Error(this.configError);
    const temporary = path.join(this.directory, `resources-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(this.directory, "resources.json"));
    this.state = next;
    await this.reload();
  }
  async prepareSkill(source: string): Promise<PreparedSkill> {
    if (!path.isAbsolute(source) || path.basename(source) !== "SKILL.md") throw new Error("Choose a local SKILL.md. Executable extensions, TUI renderers and package imports are unsupported; nothing was executed or installed.");
    const root = path.dirname(await realpath(source));
    const original = (await boundedFile(source, MAX_MARKDOWN, root)).toString("utf8");
    const parsed = loadSkills({ cwd: this.directory, agentDir: this.directory, skillPaths: [source], includeDefaults: false });
    const skill = parsed.skills[0];
    if (!skill || parsed.diagnostics.length || parsed.skills.length !== 1) throw new Error(`Invalid skill: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    if (!DESIGN_SKILLS.includes(skill.name as typeof DESIGN_SKILLS[number])) throw new Error("This skill is not in the reviewed initial pack. Only apple-design, mobile-native, emil-design-eng and prototype can be imported.");
    if (this.state.skills.some((item) => item.name === skill.name)) throw new Error(`Skill ${skill.name} is already imported. Duplicate imports are not loaded.`);
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(original)?.[0];
    if (!frontmatter) throw new Error("Skill frontmatter is missing.");
    let normalized = original.replace(frontmatter, frontmatter.replace(/^disable-model-invocation:.*\r?\n/gm, ""));
    if (skill.name === "prototype") normalized = normalized.replace("Only runs when explicitly invoked; it does not trigger on its own.", "Use for requests for multiple UI variants or alternatives.");
    // Only local Markdown links are copied. No scripts, executables, packages or arbitrary folder trees.
    const content: Record<string, string> = { "SKILL.md": normalized };
    const visit = async (text: string, parent: string): Promise<void> => {
      for (const match of text.matchAll(/\]\(([^\s)#]+\.md)(?:#[^)]*)?\)/gi)) {
        if (/^https?:/.test(match[1])) continue;
        const relative = path.posix.join(parent, match[1]);
        if (!relativeMarkdown(relative)) throw new Error("Skill Markdown dependency escapes its directory.");
        if (content[relative]) continue;
        if (Object.keys(content).length >= 16) throw new Error("Too many Markdown dependencies.");
        content[relative] = (await boundedFile(path.join(root, relative), MAX_MARKDOWN, root)).toString("utf8");
        await visit(content[relative], path.posix.dirname(relative));
      }
    };
    await visit(normalized, ".");
    if (Object.values(content).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 300_000) throw new Error("Skill pack exceeds text budget.");
    const files = Object.fromEntries(Object.entries(content).map(([file, text]) => [file, hash(text)]));
    return { record: { name: skill.name, source: await realpath(source), digest: hash(JSON.stringify({ sourceHash: hash(original), files })), enabled: true, files }, content };
  }
  async importSkill(prepared: PreparedSkill): Promise<void> {
    if (this.state.skills.some((item) => item.name === prepared.record.name)) throw new Error("Duplicate skill import.");
    const directory = this.skillDirectory(prepared.record);
    for (const [file, text] of Object.entries(prepared.content)) {
      const target = path.join(directory, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, text, { mode: 0o600 });
    }
    await this.save({ ...this.state, skills: [...this.state.skills, prepared.record] });
  }
  async prepareCatalog(file: string): Promise<{ path: string; digest: string; enabled: boolean; count: number }> {
    if (!path.isAbsolute(file) || path.basename(file) !== "catalog.json") throw new Error("Choose the local library/catalog.json file.");
    const bytes = await boundedFile(file, 2_000_000);
    const references = this.parseCatalog(bytes);
    return { path: await realpath(file), digest: hash(bytes), enabled: true, count: references.length };
  }
  async importCatalog(catalog: { path: string; digest: string; enabled: boolean }): Promise<void> {
    // Exact reviewed bytes, not a pathname whose meaning changed during approval.
    if (hash(await boundedFile(catalog.path, 2_000_000)) !== catalog.digest) throw new Error("Catalog changed during approval. Import again.");
    await this.save({ ...this.state, catalog: { path: catalog.path, digest: catalog.digest, enabled: catalog.enabled } });
  }
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (name === "catalog" && this.state.catalog) await this.save({ ...this.state, catalog: { ...this.state.catalog, enabled } });
    else {
      if (!this.state.skills.some((item) => item.name === name)) throw new Error("Unknown imported resource.");
      await this.save({ ...this.state, skills: this.state.skills.map((item) => item.name === name ? { ...item, enabled } : item) });
    }
  }
  async reload(): Promise<void> {
    this.skills = []; this.references = [];
    this.view = { skills: [], diagnostics: [this.configError, this.bundledCatalogError].filter((error): error is string => !!error), tools: ["design_read", "design_search", "design_image"] };
    for (const record of this.state.skills) {
      try {
        for (const [file, digest] of Object.entries(record.files)) {
          if (hash(await boundedFile(path.join(this.skillDirectory(record), file), MAX_MARKDOWN, this.skillDirectory(record))) !== digest) throw new Error("Imported content changed. Restore the approved copy; it has not been loaded.");
        }
        const result = loadSkills({ cwd: this.directory, agentDir: this.directory, includeDefaults: false, skillPaths: [path.join(this.skillDirectory(record), "SKILL.md")] });
        if (result.skills.length !== 1 || result.diagnostics.length || result.skills[0].disableModelInvocation) throw new Error("Imported skill is invalid or manual-only.");
        if (record.enabled) this.skills.push(result.skills[0]);
        this.view.skills.push({ ...record, loaded: record.enabled, description: result.skills[0].description });
      } catch (error) { this.view.skills.push({ ...record, loaded: false, error: String(error) }); }
    }
    const catalog = this.catalog;
    if (catalog) {
      this.view.catalog = { path: catalog.path, enabled: catalog.enabled, count: 0 };
      if (catalog.enabled) try {
        const bytes = await boundedFile(catalog.path, 2_000_000);
        if (hash(bytes) !== catalog.digest) throw new Error("Catalog changed; choose it again to approve the new version.");
        this.references = this.parseCatalog(bytes); this.view.catalog.count = this.references.length;
      } catch (error) { this.view.catalog.error = String(error); }
    }
  }
  async readSkill(name: string, file = "SKILL.md"): Promise<string> {
    const record = this.state.skills.find((item) => item.name === name && item.enabled);
    if (!record || !this.skills.some((skill) => skill.name === name)) throw new Error(`Guidance ${name} is unavailable or disabled. No approved enabled copy is available.`);
    if (!relativeMarkdown(file) || !record.files[file]) throw new Error("Only reviewed Markdown files can be read. Executable resources and terminal UI are unsupported.");
    const bytes = await boundedFile(path.join(this.skillDirectory(record), file), MAX_MARKDOWN, this.skillDirectory(record));
    if (hash(bytes) !== record.files[file]) throw new Error("Guidance changed since approval; reading was refused.");
    return bytes.toString("utf8");
  }
  async guidance(text: string, mobile = false): Promise<string> {
    const explicit = /^\/(?:skill:)?([a-z-]+)(?:\s|$)/.exec(text)?.[1];
    if (explicit && !this.skills.some((skill) => skill.name === explicit)) throw new Error(`Guidance ${explicit} is unavailable. No approved enabled copy is available.`);
    const names = classifyDesignRequest(text, mobile).filter((name) => this.skills.some((skill) => skill.name === name));
    if (!names.length) return "";
    const prefix = `${GUIDANCE_MARKER}\nUse the following loaded guidance for this request, subject to host safety and target-project conventions. Do not narrate activation.\n`;
    const suffix = "\n</mauxi_guidance>";
    const bodies: string[] = [];
    let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
    for (const name of names) {
      const record = this.state.skills.find((item) => item.name === name)!;
      // The import manifest is already deduplicated, including transitive/cyclic
      // links. Attach only its reviewed files, with SKILL.md first, and recheck
      // every file's digest rather than trusting its earlier load-time check.
      const files = ["SKILL.md", ...Object.keys(record.files).filter((file) => file !== "SKILL.md").sort()];
      for (const file of files) {
        const body = `Guidance: ${name}\nFile: ${file}\n${await this.readSkill(name, file)}`;
        bytes += Buffer.byteLength(body) + (bodies.length ? 2 : 0);
        if (bytes > 300_000) throw new Error("Selected guidance exceeds the 300,000-byte request budget. Split this request; no guidance was sent.");
        bodies.push(body);
      }
    }
    return `${prefix}${bodies.join("\n\n")}${suffix}`;
  }
  private parseCatalog(bytes: Buffer): Reference[] {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.version !== 1 || !Array.isArray(value.references) || value.references.length > 1_000) throw new Error("Unsupported or oversized catalog.");
    const ids = new Set<string>();
    return value.references.filter((item: { reviewStatus?: string } | null) => item?.reviewStatus !== "candidate").map((item: Reference & { reviewStatus?: string }) => {
      if (!item || !/^[\w-]{1,160}$/.test(item.id) || ids.has(item.id) || typeof item.family !== "string" || typeof item.cue !== "string" || item.cue.length > 2_000
        || typeof item.source !== "string" || !Array.isArray(item.tags) || item.tags.length > 40 || !item.tags.every((tag) => typeof tag === "string" && tag.length <= 100)
        || item.reviewStatus !== "reviewed" || !item.sha256) throw new Error("Catalog contains malformed, duplicate or unreviewed entries.");
      for (const field of ["imagePath", "mobileImagePath"] as const) {
        const file = item[field];
        if (field === "mobileImagePath" && file === undefined) continue;
        if (typeof file !== "string" || !/^images\/[\w-]+\.webp$/.test(file) || !/^[a-f0-9]{64}$/.test(item.sha256[field] ?? "")) throw new Error("Catalog image path or digest is invalid.");
      }
      ids.add(item.id); return item;
    });
  }
  search(query: string, viewport: "desktop" | "mobile" = "desktop"): Array<Reference & { score: number }> {
    if (!this.catalog?.enabled || this.view.catalog?.error) throw new Error(`Visual library unavailable. ${this.view.catalog?.error ?? this.view.diagnostics.join(" ")}`.trim());
    const expanded = query.toLowerCase().replace(/testimonials?|reviews?/g, "social_proof").replace(/metrics|numbers/g, "stats").replace(/questions/g, "faq").replace(/plans|subscription/g, "pricing").replace(/steps|process/g, "how_it_works");
    const words = [...new Set(expanded.match(/[\p{L}_-]{3,}/gu) ?? [])].filter((word) => !["the", "for", "with", "make", "more", "this", "and", "mobile", "desktop"].includes(word));
    const requestedFamilies = words.filter((word) => ["hero", "pricing", "faq", "feature", "footer", "social_proof", "stats", "how_it_works", "cta", "about", "contact"].includes(word));
    return this.references.filter((item) => !requestedFamilies.length || requestedFamilies.includes(item.family)).map((item) => ({ ...item, score: words.reduce((sum, word) => sum + (item.family === word ? 12 : item.tags.some((tag) => tag.toLowerCase() === word) ? 5 : `${item.id} ${item.cue}`.toLowerCase().includes(word) ? 2 : 0), 0) }))
      .filter((item) => item.score > 0 && (viewport !== "mobile" || item.mobileImagePath))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5);
  }
  async image(id: string, viewport: "desktop" | "mobile", supportsImages: boolean): Promise<{ type: "image"; data: string; mimeType: "image/webp" }> {
    if (!supportsImages) throw new Error("This model cannot inspect images. Use catalog text as metadata only, or choose an image-capable model.");
    const reference = this.references.find((item) => item.id === id);
    if (!this.catalog?.enabled || !reference) throw new Error("Unknown or disabled image.");
    const field = viewport === "mobile" ? "mobileImagePath" : "imagePath";
    const file = reference[field]; if (!file) throw new Error("No matching viewport image.");
    const root = path.dirname(this.catalog.path);
    const bytes = await boundedFile(path.join(root, file), 8 * 1024 * 1024, root);
    if (hash(bytes) !== reference.sha256[field] || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("Image content is invalid or changed since catalog review.");
    return { type: "image", data: bytes.toString("base64"), mimeType: "image/webp" };
  }
}
