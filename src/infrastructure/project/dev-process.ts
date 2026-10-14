import { readFile, readdir, realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { LaunchPlan } from "../../application/project-contract";

const MAX_LOG_LINES = 400;
const MAX_LINE_LENGTH = 4_000;

export async function isPortOccupied(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function environmentForExecutable(executable: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const currentPath = base.PATH ?? "";
  const toolDirectory = path.isAbsolute(executable) ? path.dirname(executable) : "";
  return {
    ...base,
    PATH: toolDirectory ? [toolDirectory, currentPath].filter(Boolean).join(path.delimiter) : currentPath,
    BROWSER: "none",
    FORCE_COLOR: "0",
  };
}

export class OwnedDevProcess {
  private child: ChildProcess | null = null;
  private groupId: number | null = null;
  private readonly lines: string[] = [];
  private pending = "";

  constructor(private readonly onLog: (line: string) => void, private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void) {}

  get pid(): number | null { return this.child?.pid ?? null; }
  get logs(): string[] { return [...this.lines]; }

  start(plan: LaunchPlan, sessionLauncher?: string): void {
    if (this.child || this.groupId) throw new Error("The owned development process is already running.");
    const executable = sessionLauncher ? "node" : plan.executable;
    const args = sessionLauncher ? [sessionLauncher, plan.executable, ...plan.args] : plan.args;
    const child = spawn(executable, args, {
      cwd: plan.appRoot,
      env: environmentForExecutable(plan.executable),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.groupId = child.pid ?? null;
    const collect = (chunk: Buffer | string) => {
      const pieces = String(chunk).split("\n");
      for (let index = 0; index < pieces.length; index++) {
        this.pending += pieces[index].slice(0, MAX_LINE_LENGTH - this.pending.length);
        if (index < pieces.length - 1) { this.addLine(this.pending.replace(/\r$/, "")); this.pending = ""; }
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => this.addLine(`Failed to start: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (this.pending) this.addLine(this.pending);
      this.pending = "";
      this.child = null;
      this.onExit(code, signal);
    });
  }

  private addLine(value: string): void {
    const line = value.slice(0, MAX_LINE_LENGTH);
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    this.onLog(line);
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    const pid = this.groupId;
    if (!pid) return;
    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      try { process.kill(-pid, signal); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
    };
    if (signalGroup("SIGTERM")) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && signalGroup(0)) await new Promise(resolve => setTimeout(resolve, 25));
      if (signalGroup(0)) signalGroup("SIGKILL");
    }
    this.groupId = null;
  }
}

export async function waitForHttp(origin: string, timeoutMs: number, aborted: () => boolean, requiredHtml?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "No response";
  while (Date.now() < deadline) {
    if (aborted()) throw new Error("Development server stopped before it became ready.");
    try {
      const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(1_500) });
      if (response.status >= 200 && response.status < 500) {
        if (!requiredHtml || (await response.text()).includes(requiredHtml)) return;
        lastError = "The server has not loaded the Mauxi preview integration yet";
      } else lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out waiting for ${origin}: ${lastError}`);
}

export async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No local port available")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export function withSessionPort(plan: LaunchPlan, port: number): LaunchPlan {
  const direct = plan.framework === "vite" ? /^vite(?:\s+--?[\w=./:-]+(?:\s+[\w=./:-]+)?)*\s*$/ : /^next\s+dev(?:\s+--?[\w=./:-]+(?:\s+[\w=./:-]+)?)*\s*$/;
  if (!direct.test(plan.scriptCommand)) {
    if (port !== plan.port) throw new Error("This development script cannot accept a temporary port safely. Free its configured port or use a direct Vite/Next development script.");
    return plan;
  }
  const flags = ["--port", String(port), ...(plan.framework === "vite" ? ["--strictPort"] : [])];
  return { ...plan, port, origin: `http://127.0.0.1:${port}`, args: [...plan.args, ...(plan.packageManager === "npm" ? ["--"] : []), ...flags], commandDisplay: `${plan.commandDisplay} ${plan.packageManager === "npm" ? "-- " : ""}${flags.join(" ")}` };
}

export async function existingNextServer(appRoot: string): Promise<number | null> {
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (await realpath(`/proc/${entry}/cwd`) !== appRoot) continue;
      const argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      if (argv[0]?.startsWith("next-server (") || argv.some((arg, index) => /(?:^|\/)next$/.test(arg) && argv[index + 1] === "dev")) return Number(entry);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return null;
}
