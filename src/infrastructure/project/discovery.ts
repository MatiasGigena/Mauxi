import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  IntegrationPreview,
  LaunchPlan,
  ProjectDiagnostic,
  ProjectDiscovery,
  SupportedFramework,
  SupportedPackageManager,
} from "../../application/project-contract";
import { previewIntegrationPlan } from "../instrumentation/plan";

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 1_048_576;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "build", ".mauxi"]);

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  mauxi?: unknown;
}

export function validateStartPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\s?#]/.test(value)) throw new Error("The initial route must be a local path such as /login, without an origin, query or fragment.");
  const url = new URL(value, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1") throw new Error("The initial route must stay within the project origin.");
  return url.pathname;
}

function projectStartPath(manifest: PackageManifest): string {
  if (manifest.mauxi === undefined) return "/";
  const config = manifest.mauxi;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("package.json mauxi must be an object.");
  const value = (config as Record<string, unknown>).startPath ?? "/";
  return validateStartPath(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function isFile(filePath: string): Promise<boolean> {
  try { return (await lstat(filePath)).isFile(); } catch { return false; }
}

async function readManifest(filePath: string): Promise<PackageManifest> {
  const file = await lstat(filePath);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`Manifest must be a regular file: ${filePath}`);
  if (file.size > MAX_MANIFEST_BYTES) throw new Error(`Manifest is larger than ${MAX_MANIFEST_BYTES} bytes: ${filePath}`);
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid package.json: ${filePath}`);
  return value as PackageManifest;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function packageVersions(manifest: PackageManifest): Record<string, string> {
  return { ...stringRecord(manifest.dependencies), ...stringRecord(manifest.devDependencies) };
}

function detectFramework(manifest: PackageManifest): SupportedFramework | null {
  const packages = packageVersions(manifest);
  if (typeof packages.next === "string") return "next";
  if (typeof packages.vite === "string" && (typeof packages.react === "string" || typeof packages["react-dom"] === "string")) return "vite";
  return null;
}

async function detectPackageManager(root: string, manifest: PackageManifest): Promise<SupportedPackageManager> {
  const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  if (await isFile(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await isFile(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function workspacePatterns(manifest: PackageManifest): string[] {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces.filter((item): item is string => typeof item === "string");
  if (manifest.workspaces && typeof manifest.workspaces === "object" && "packages" in manifest.workspaces) {
    const packages = (manifest.workspaces as { packages?: unknown }).packages;
    return Array.isArray(packages) ? packages.filter((item): item is string => typeof item === "string") : [];
  }
  return [];
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function canonicalWorkspaceCandidate(root: string, candidate: string): Promise<string | null> {
  try {
    const canonical = await realpath(candidate);
    if (!isInsideRoot(root, canonical)) return null;
    return (await lstat(canonical)).isDirectory() ? canonical : null;
  } catch { return null; }
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalized.endsWith("/*") && !normalized.slice(0, -2).includes("*")) {
    const lexicalParent = path.resolve(root, normalized.slice(0, -2));
    if (!isInsideRoot(root, lexicalParent)) return [];
    try {
      const parent = await realpath(lexicalParent);
      if (!isInsideRoot(root, parent)) return [];
      return (await readdir(parent, { withFileTypes: true }))
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !IGNORED_DIRECTORIES.has(entry.name))
        .map((entry) => path.join(parent, entry.name));
    } catch { return []; }
  }
  if (normalized.includes("*")) return [];
  const candidate = path.resolve(root, normalized);
  return isInsideRoot(root, candidate) ? [candidate] : [];
}

function isNextClientVersion(value: string): boolean {
  const match = value.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 15 || (major === 15 && minor >= 3);
}

async function supportsNextClientInstrumentation(manifest: PackageManifest, appRoot: string, projectRoot: string): Promise<boolean> {
  const declared = packageVersions(manifest).next ?? "";
  if (isNextClientVersion(declared)) return true;
  for (const root of new Set([appRoot, projectRoot])) {
    const installedManifest = path.join(root, "node_modules", "next", "package.json");
    if (!(await isFile(installedManifest))) continue;
    try {
      const installed = await readManifest(installedManifest);
      if (typeof installed.version === "string" && isNextClientVersion(installed.version)) return true;
    } catch {}
  }
  return false;
}

function scriptCandidates(manifest: PackageManifest, framework: SupportedFramework): Array<[string, string]> {
  const scripts = stringRecord(manifest.scripts);
  const preferred = ["dev", "start"];
  const candidates = Object.entries(scripts).filter(([, command]) => {
    if (framework === "vite") return /(^|\s|\/|\\)vite(?=\s|$)(?!\s+(?:build|preview|optimize)(?:\s|$))/.test(command);
    return /(^|\s|\/|\\)next\s+dev(?:\s|$)/.test(command);
  });
  return candidates.sort(([a], [b]) => {
    const ai = preferred.indexOf(a); const bi = preferred.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
  });
}

async function resolvePackageManagerExecutable(manager: SupportedPackageManager): Promise<string | null> {
  const home = os.homedir();
  const directories = new Set((process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  for (const candidate of [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
  ]) directories.add(candidate);
  for (const versionRoot of [path.join(home, ".nvm", "versions", "node"), path.join(home, ".local", "share", "fnm", "node-versions")]) {
    try {
      for (const entry of await readdir(versionRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        directories.add(versionRoot.endsWith("node-versions")
          ? path.join(versionRoot, entry.name, "installation", "bin")
          : path.join(versionRoot, entry.name, "bin"));
      }
    } catch {}
  }
  for (const directory of directories) {
    const candidate = path.join(directory, manager);
    try { await access(candidate, constants.X_OK); return candidate; }
    catch {}
  }
  return null;
}

function commandFor(manager: SupportedPackageManager, executable: string, script: string): { executable: string; args: string[]; display: string } {
  if (manager === "npm") return { executable, args: ["run", script], display: `npm run ${script}` };
  return { executable, args: [script], display: `${manager} ${script}` };
}

function detectedPort(command: string, framework: SupportedFramework): number {
  const explicit = command.match(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+)(\d{2,5})(?:\s|$)/)?.[1];
  const port = explicit ? Number(explicit) : framework === "vite" ? 5173 : 3000;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : framework === "vite" ? 5173 : 3000;
}

async function gitStatus(root: string): Promise<{ repository: boolean; dirty: boolean | null }> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: root,
      timeout: 5_000,
      maxBuffer: 1_048_576,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return { repository: true, dirty: stdout.length > 0 };
  } catch { return { repository: false, dirty: null }; }
}

async function configurationFingerprint(appRoot: string, projectRoot: string, manager: SupportedPackageManager, framework: SupportedFramework): Promise<string> {
  const lockName = manager === "pnpm" ? "pnpm-lock.yaml" : manager === "yarn" ? "yarn.lock" : "package-lock.json";
  const frameworkFiles = framework === "vite"
    ? ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]
    : [
      "next.config.ts", "next.config.mjs", "next.config.js",
      "instrumentation-client.ts", "instrumentation-client.js", "instrumentation-client.tsx", "instrumentation-client.jsx",
      "src/instrumentation-client.ts", "src/instrumentation-client.js", "src/instrumentation-client.tsx", "src/instrumentation-client.jsx",
    ];
  const paths = [...new Set([
    path.join(projectRoot, "package.json"),
    path.join(appRoot, "package.json"),
    path.join(appRoot, lockName),
    path.join(projectRoot, lockName),
    ...frameworkFiles.map((name) => path.join(appRoot, name)),
  ])];
  const digest = createHash("sha256");
  for (const filePath of paths) {
    if (!(await isFile(filePath))) continue;
    const file = await lstat(filePath);
    if (file.isSymbolicLink() || file.size > 50 * 1_048_576) throw new Error(`Approval input is unsupported or too large: ${filePath}`);
    digest.update(filePath).update("\0").update(await readFile(filePath)).update("\0");
  }
  return digest.digest("hex");
}

async function dependenciesPresent(appRoot: string, projectRoot: string, framework: SupportedFramework): Promise<boolean> {
  const executable = framework === "next" ? "next" : "vite";
  for (const root of new Set([appRoot, projectRoot])) {
    try {
      await access(path.join(root, "node_modules", ".bin", executable));
      return true;
    } catch {}
  }
  return false;
}

async function integrationPreview(root: string, framework: SupportedFramework): Promise<IntegrationPreview> {
  try { return await previewIntegrationPlan(root, framework); }
  catch (error) {
    return { supported: false, summary: error instanceof Error ? error.message : String(error), files: [] };
  }
}

export async function discoverProject(selectedPath: string, rememberedPlanId: string | null = null): Promise<ProjectDiscovery> {
  const selectedRoot = path.resolve(selectedPath);
  const canonicalRoot = await realpath(selectedRoot);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory()) throw new Error("Choose a project folder, not a file.");

  const diagnostics: ProjectDiagnostic[] = [];
  const rootManifestPath = path.join(canonicalRoot, "package.json");
  if (!(await isFile(rootManifestPath))) {
    return {
      discoveryId: randomUUID(), selectedRoot, canonicalRoot, packageJsonPath: null,
      git: await gitStatus(canonicalRoot), plans: [], rememberedPlanId: null,
      diagnostics: [{ level: "error", code: "missing-manifest", message: "No package.json was found in the selected folder." }],
    };
  }

  const rootManifest = await readManifest(rootManifestPath);
  const candidateRoots = new Set<string>([canonicalRoot]);
  for (const pattern of workspacePatterns(rootManifest)) {
    const expanded = await expandWorkspacePattern(canonicalRoot, pattern);
    for (const candidate of expanded) {
      const canonical = await canonicalWorkspaceCandidate(canonicalRoot, candidate);
      if (canonical) candidateRoots.add(canonical);
      else diagnostics.push({ level: "warning", code: "escaped-workspace", message: `Ignored workspace pattern ${pattern}: its resolved path is unavailable or outside the selected project.` });
    }
  }

  const plans: LaunchPlan[] = [];
  for (const candidateRoot of candidateRoots) {
    const manifestPath = path.join(candidateRoot, "package.json");
    if (!(await isFile(manifestPath))) continue;
    let manifest: PackageManifest;
    try { manifest = await readManifest(manifestPath); }
    catch (error) {
      diagnostics.push({ level: "warning", code: "invalid-workspace-manifest", message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const framework = detectFramework(manifest);
    if (!framework) continue;
    const manager = await detectPackageManager(canonicalRoot, rootManifest);
    const scripts = scriptCandidates(manifest, framework);
    const managerExecutable = await resolvePackageManagerExecutable(manager);
    const integration = await integrationPreview(candidateRoot, framework);
    const installed = await dependenciesPresent(candidateRoot, canonicalRoot, framework);
    const approvalFingerprint = await configurationFingerprint(candidateRoot, canonicalRoot, manager, framework);
    const nextClientSupported = framework !== "next" || await supportsNextClientInstrumentation(manifest, candidateRoot, canonicalRoot);
    for (const [scriptName, rawCommand] of scripts) {
      const command = commandFor(manager, managerExecutable ?? manager, scriptName);
      const port = detectedPort(rawCommand, framework);
      const planDiagnostics: ProjectDiagnostic[] = [];
      let startPath = "/";
      try { startPath = projectStartPath(manifest); }
      catch (error) { planDiagnostics.push({ level: "error", code: "invalid-start-path", message: String(error) }); }
      if (!managerExecutable) planDiagnostics.push({ level: "error", code: "missing-toolchain", message: `${manager} was not found in PATH or the supported Linux user tool locations.` });
      if (!nextClientSupported) planDiagnostics.push({ level: "error", code: "unsupported-next-version", message: "This Next.js version does not support instrumentation-client. Mauxi currently requires Next.js 15.3 or newer." });
      if (!installed) planDiagnostics.push({ level: "error", code: "missing-dependencies", message: `Dependencies are missing. Run ${manager} install yourself, then retry; Mauxi will not install them.` });
      if (!integration.supported) planDiagnostics.push({ level: "error", code: "unsupported-integration", message: integration.summary });
      const relative = path.relative(canonicalRoot, candidateRoot) || ".";
      const id = hash(JSON.stringify({
        candidateRoot,
        framework,
        manager,
        scriptName,
        rawCommand,
        port,
        installed,
        integration,
        approvalFingerprint,
        managerExecutable,
      }));
      plans.push({
        id,
        label: `${relative === "." ? (typeof manifest.name === "string" ? manifest.name : path.basename(candidateRoot)) : relative} — ${scriptName}`,
        projectRoot: canonicalRoot,
        appRoot: candidateRoot,
        framework,
        packageManager: manager,
        scriptName,
        scriptCommand: rawCommand,
        configurationFingerprint: approvalFingerprint,
        commandDisplay: command.display,
        executable: command.executable,
        args: command.args,
        origin: `http://127.0.0.1:${port}`,
        startPath,
        port,
        dependenciesPresent: installed,
        integration,
        diagnostics: planDiagnostics,
      });
    }
  }

  if (!plans.length) diagnostics.push({ level: "error", code: "unsupported-project", message: "No supported React + Vite or Next.js development script was found. Mauxi did not execute project configuration." });
  if (plans.length > 1) diagnostics.push({ level: "warning", code: "ambiguous-plan", message: "Multiple app roots or development scripts were found. Choose one before continuing." });
  return {
    discoveryId: randomUUID(), selectedRoot, canonicalRoot, packageJsonPath: rootManifestPath,
    git: await gitStatus(canonicalRoot), plans,
    rememberedPlanId: plans.some((plan) => plan.id === rememberedPlanId) ? rememberedPlanId : null,
    diagnostics,
  };
}
