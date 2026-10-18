import { closeProject as closeWorkspace } from "../helpers/workspace-controls";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SelectionSchema = Type.Object({ preview: Type.Union([Type.Literal("desktop"), Type.Literal("mobile")]), selector: Type.String() });

const TaskSchema = Type.Object({
  id: Type.String(),
  prompt: Type.String(),
  selections: Type.Array(SelectionSchema),
  agentControl: Type.Boolean(),
  reducedMotionCheck: Type.Boolean(),
  timeoutMinutes: Type.Number(),
});

const ProjectSchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  framework: Type.Union([Type.Literal("vite"), Type.Literal("next")]),
  setup: Type.Array(SelectionSchema),
  tasks: Type.Array(TaskSchema),
});

const PlanSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  authFrom: Type.String(),
  evidence: Type.String(),
  projects: Type.Array(ProjectSchema),
});

type Plan = Static<typeof PlanSchema>;

type Project = Static<typeof ProjectSchema>;

type Task = Static<typeof TaskSchema>;

interface Approval { title: string; operation: string; answer: "approve" | "deny" }

interface TaskEvidence {
  id: string;
  seconds: number;
  runState: string;
  error?: string;
  approvals: Approval[];
  response: string;
  changedFiles: string[];
  diffSha256: string;
}

interface ProjectEvidence {
  name: string;
  framework: string;
  revision: string;
  openSeconds: number;
  model?: string;
  providerAuthenticated: boolean;
  tasks: TaskEvidence[];
  cycles: Array<{ cycle: number; bridges: number; stoppedPids: number[] }>;
  restart?: { providerAuthenticated: boolean; changedWhileOpen: string[]; sessionResumed: boolean };
  finalClean?: { processes: number[]; integrationAbsent: boolean; worktreeMatchesAgentCommits: boolean };
}

interface LiveReport {
  artifact: string;
  sha256: string;
  provider: string;
  model: string;
  startedAt: string;
  runtime?: { packaged: boolean; versions: Record<string, string> };
  projects: ProjectEvidence[];
}

const exec = promisify(execFile);
const artifact = path.resolve(process.env.MAUXI_APPIMAGE ?? "release/Mauxi-0.1.0-x86_64.AppImage");
const planFile = process.env.MAUXI_LIVE_PLAN;
const integrationPaths = [":(exclude).mauxi", ":(exclude)instrumentation-client.*", ":(exclude)src/instrumentation-client.*", ":(exclude)vite.config.*", ":(exclude)next.config.*"];

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, maxBuffer: 64 * 1_048_576 })).stdout;
}

async function projectProcesses(root: string): Promise<number[]> {
  const result: number[] = [];

  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;

    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);

      if (cwd === root || cwd.startsWith(`${root}/`)) result.push(Number(pid));
    } catch {}
  }

  return result;
}

async function snapshot(page: Page) {
  return page.evaluate(() => window.mauxi!.agentBootstrap());
}

async function openProject(app: ElectronApplication, page: Page, project: Project) {
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project.path);
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const next = app.waitForEvent("window", { timeout: 300_000 });
  await page.getByRole("button", { name: /Confirm.*start/i }).click();
  page = await next;
  await expect(page.locator(".bridge-ready")).toHaveCount(2, { timeout: 300_000 });
  await expect.poll(async () => (await snapshot(page)).ready, { timeout: 60_000 }).toBe(true);

  return page;
}

async function closeProject(app: ElectronApplication, page: Page) {
  const next = app.waitForEvent("window");
  await closeWorkspace(page);
  page = await next;
  await expect(page.getByRole("button", { name: "Open Project", exact: true })).toBeVisible({ timeout: 120_000 });

  return page;
}

async function shot(page: Page, plan: Plan, name: string) {
  await page.screenshot({ path: path.join(plan.evidence, "shots", `${name}.png`) });
}

async function select(page: Page, selection: Static<typeof SelectionSchema>, expected: number) {
  const frame = page.frameLocator(`[data-testid="${selection.preview}-preview"]`);
  const label = selection.preview === "desktop" ? "Desktop" : "Mobile";
  const target = frame.locator(selection.selector).first();
  await expect(target).toBeVisible({ timeout: 60_000 });
  await target.evaluate(node => node.scrollIntoView({ block: "center" }));

  await expect.poll(() => target.evaluate(node => {
    const r = node.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + Math.min(r.width / 2, 24), r.y + Math.min(r.height / 2, 24));

    return !!top && (top === node || node.contains(top));
  }), { timeout: 60_000 }).toBe(true);
  await page.getByRole("button", { name: `Select in ${label}`, exact: true }).click();
  await expect.poll(() => frame.locator("html").evaluate(node => getComputedStyle(node).cursor)).toBe("crosshair");
  const frameBox = (await page.getByTestId(`${selection.preview}-preview`).boundingBox())!;

  const point = await target.evaluate(node => {
    const r = node.getBoundingClientRect();

    return { x: r.x + Math.min(r.width / 2, 24), y: r.y + Math.min(r.height / 2, 24), width: innerWidth, height: innerHeight };
  });

  await page.mouse.click(frameBox.x + point.x * frameBox.width / point.width, frameBox.y + point.y * frameBox.height / point.height);
  await expect(page.locator(".selection-chip")).toHaveCount(expected, { timeout: 30_000 });
  await page.getByRole("button", { name: `Select in ${label}`, exact: true }).click();
}

async function runTask(page: Page, plan: Plan, project: Project, task: Task): Promise<TaskEvidence> {
  const started = Date.now();
  const approvals: Approval[] = [];
  await shot(page, plan, `${project.name}-${task.id}-before`);

  for (const [index, selection] of task.selections.entries()) await select(page, selection, index + 1);

  if (task.agentControl) {
    await expect(page.getByRole("button", { name: "Give agent control", exact: true })).toBeEnabled({ timeout: 60_000 });
    await page.getByRole("button", { name: "Give agent control", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take back control", exact: true })).toBeVisible({ timeout: 30_000 });
  }

  const before = (await snapshot(page)).messages.length;
  await page.getByLabel("Message", { exact: true }).fill(task.prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).messages.length, { timeout: 60_000 }).toBeGreaterThan(before);
  const deadline = started + task.timeoutMinutes * 60_000;
  let state = await snapshot(page);

  while (Date.now() < deadline) {
    const dialog = page.locator(".permission-dialog").first();

    if (await dialog.isVisible()) {
      const title = (await dialog.locator("h2").textContent()) ?? "";
      const operation = (await dialog.getByLabel("Exact operation").textContent()) ?? "";
      const answer = title === "Approve browser action" ? "approve" : "deny";
      approvals.push({ title, operation: operation.slice(0, 2_000), answer });
      await shot(page, plan, `${project.name}-${task.id}-approval-${approvals.length}`);
      await dialog.getByRole("button", { name: answer === "approve" ? "Approve once" : "Deny", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 }).catch(() => {});
      continue;
    }

    const question = page.getByRole("dialog", { name: "Mauxi needs your input" });

    if (await question.isVisible()) {
      approvals.push({ title: (await question.locator("h2").textContent()) ?? "", operation: ((await question.textContent()) ?? "").slice(0, 2_000), answer: "deny" });
      await shot(page, plan, `${project.name}-${task.id}-question-${approvals.length}`);
      await question.getByRole("button", { name: "Cancel", exact: true }).click();
      continue;
    }

    state = await snapshot(page);

    if ((state.runState === "idle" || state.runState === "error") && !state.messages.some(message => message.pending)) break;
    await page.waitForTimeout(2_000);
  }

  if (state.runState !== "idle" && state.runState !== "error") {
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    state = await snapshot(page);
  }

  const takeBack = page.getByRole("button", { name: "Take back control", exact: true });

  if (await takeBack.isVisible()) await takeBack.click();
  await page.waitForTimeout(3_000);
  await shot(page, plan, `${project.name}-${task.id}-after`);

  if (task.reducedMotionCheck) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(1_500);
    await shot(page, plan, `${project.name}-${task.id}-reduced-motion`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }

  const changedFiles = (await git(project.path, "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...integrationPaths)).split("\n").filter(Boolean);
  await git(project.path, "add", "-A", "--", ".", ...integrationPaths);
  const diff = await git(project.path, "diff", "--cached");
  await writeFile(path.join(plan.evidence, "diffs", `${project.name}-${task.id}.diff`), diff);

  if (diff) await git(project.path, "-c", "user.name=acceptance", "-c", "user.email=acceptance@localhost", "commit", "-q", "-m", `acceptance: after ${task.id}`);

  return {
    id: task.id,
    seconds: Math.round((Date.now() - started) / 1_000),
    runState: state.runState,
    error: state.error?.message,
    approvals,
    response: state.messages.filter(message => message.role === "assistant").at(-1)?.text ?? "",
    changedFiles,
    diffSha256: createHash("sha256").update(diff).digest("hex"),
  };
}

test.skip(!planFile, "Live acceptance needs MAUXI_LIVE_PLAN; it uses a real provider and never runs by default");

test("real projects: AppImage without pi, live-model agent tasks, visible checks and lifecycle", async () => {
  const plan = Value.Parse(PlanSchema, JSON.parse(await readFile(planFile!, "utf8")));
  const home = path.join(plan.evidence, "home"); const bin = path.join(plan.evidence, "bin");
  const profile = path.join(home, "config", "Mauxi", "pi-profile");

  for (const directory of [home, bin, profile, path.join(plan.evidence, "shots"), path.join(plan.evidence, "diffs")]) await mkdir(directory, { recursive: true, mode: 0o700 });

  for (const tool of ["node", "npm", "npx"]) {
    const target = (await exec("which", [tool])).stdout.trim();
    await lstat(path.join(bin, tool)).catch(() => symlink(target, path.join(bin, tool)));
  }

  await copyFile(plan.authFrom, path.join(profile, "auth.json"));
  await chmod(path.join(profile, "auth.json"), 0o600);
  await writeFile(path.join(profile, "model-preference.json"), JSON.stringify({ defaultProvider: plan.provider, defaultModel: plan.model }), { mode: 0o600 });

  const env = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    PATH: `${bin}:/usr/bin:/bin`, APPIMAGE_EXTRACT_AND_RUN: "1", NEXT_TELEMETRY_DISABLED: "1", PI_TELEMETRY: "0",
    ...Object.fromEntries(["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
  };

  await expect(exec("/bin/sh", ["-c", "command -v pi"], { env })).rejects.toThrow();

  const report: LiveReport = {
    artifact,
    sha256: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: plan.provider,
    model: plan.model,
    startedAt: new Date().toISOString(),
    projects: [],
  };

  const save = () => writeFile(path.join(plan.evidence, "report.json"), JSON.stringify(report, null, 2));
  const launch = () => electron.launch({ executablePath: artifact, args: [], env, chromiumSandbox: true, timeout: 90_000 });
  let app = await launch();

  try {
    report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node } }));
    let page = await app.firstWindow();

    for (const project of plan.projects) {
      const evidence: ProjectEvidence = { name: project.name, framework: project.framework, revision: (await git(project.path, "rev-parse", "HEAD")).trim(), openSeconds: 0, providerAuthenticated: false, tasks: [], cycles: [] };
      report.projects.push(evidence);
      const opened = Date.now();
      page = await openProject(app, page, project);
      evidence.openSeconds = Math.round((Date.now() - opened) / 1_000);
      let state = await snapshot(page);
      const model = state.models.find(item => item.provider === plan.provider && item.id === plan.model);
      expect(model, `${plan.provider}/${plan.model} is in the catalog`).toBeDefined();

      if (state.selectedModel !== model!.key) await page.evaluate(input => window.mauxi!.agentSelectModel(input), { workspaceId: state.workspaceId, modelKey: model!.key });
      state = await snapshot(page);
      evidence.model = state.selectedModel;
      evidence.providerAuthenticated = state.providers.find(item => item.id === plan.provider)?.authenticated ?? false;
      expect(evidence.providerAuthenticated).toBe(true);

      for (const action of project.setup) await page.frameLocator(`[data-testid="${action.preview}-preview"]`).locator(action.selector).first().click({ timeout: 60_000 });
      await shot(page, plan, `${project.name}-opened`);
      await save();

      for (const task of project.tasks) {
        try { evidence.tasks.push(await runTask(page, plan, project, task)); }
        catch (error) {
          await shot(page, plan, `${project.name}-${task.id}-failed`).catch(() => {});
          evidence.tasks.push({ id: task.id, seconds: 0, runState: "harness-failed", error: String(error).slice(0, 2_000), approvals: [], response: "", changedFiles: [], diffSha256: "" });
          await page.keyboard.press("Escape");
          const takeBack = page.getByRole("button", { name: "Take back control", exact: true });

          if (await takeBack.isVisible()) await takeBack.click();
          const chips = page.locator(".selection-chip").getByRole("button", { name: /Remove selection/ });

          while (await chips.count()) await chips.first().click();
        }

        await save();
      }

      const sessionId = (await snapshot(page)).sessionId;

      for (let cycle = 0; cycle < 2; cycle++) {
        const pids = await projectProcesses(project.path);
        page = await closeProject(app, page);
        await expect.poll(() => projectProcesses(project.path), { timeout: 30_000 }).toEqual([]);
        page = await openProject(app, page, project);
        evidence.cycles.push({ cycle, bridges: await page.locator(".bridge-ready").count(), stoppedPids: pids });
        await save();
      }

      page = await closeProject(app, page);
      await app.close();
      app = await launch();
      page = await openProject(app, await app.firstWindow(), project);
      state = await snapshot(page);
      const pending = (await git(project.path, "status", "--porcelain=v1", "--", ".", ...integrationPaths)).trim();

      evidence.restart = {
        providerAuthenticated: state.providers.find(item => item.id === plan.provider)?.authenticated ?? false,
        changedWhileOpen: pending.split("\n").filter(Boolean),
        sessionResumed: !!sessionId && state.sessionId === sessionId,
      };

      page = await closeProject(app, page);
      await expect.poll(() => projectProcesses(project.path), { timeout: 30_000 }).toEqual([]);
      const integrationAbsent = await lstat(path.join(project.path, ".mauxi", "bridge.js")).then(() => false, () => true);

      evidence.finalClean = {
        processes: await projectProcesses(project.path),
        integrationAbsent,
        worktreeMatchesAgentCommits: (await git(project.path, "status", "--porcelain=v1")).trim() === "",
      };

      await save();
    }
  } finally {
    await save();
    await app.close().catch(() => {});
  }

  for (const project of report.projects) {
    expect(project.finalClean).toMatchObject({ processes: [], integrationAbsent: true, worktreeMatchesAgentCommits: true });
    expect(project.restart?.providerAuthenticated).toBe(true);
  }
});
