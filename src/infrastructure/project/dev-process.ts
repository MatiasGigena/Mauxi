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

  start(plan: LaunchPlan): void {
    if (this.child || this.groupId) throw new Error("The owned development process is already running.");
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.appRoot,
      env: environmentForExecutable(plan.executable),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.groupId = child.pid ?? null;
    const collect = (chunk: Buffer | string) => {
      // Bound even a stream that never emits a newline. Keep only the prefix
      // of each logical line; incoming chunks cannot accumulate indefinitely.
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
    // Leader exit says nothing about its ordinary descendants. The group stays
    // owned until stop, including when the launcher exits before stop is called.
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
