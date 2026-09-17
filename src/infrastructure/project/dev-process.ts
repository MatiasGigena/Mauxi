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
  private readonly lines: string[] = [];
  private pending = "";

  constructor(private readonly onLog: (line: string) => void, private readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void) {}

  get pid(): number | null { return this.child?.pid ?? null; }
  get logs(): string[] { return [...this.lines]; }

  start(plan: LaunchPlan): void {
    if (this.child) throw new Error("The owned development process is already running.");
    const child = spawn(plan.executable, plan.args, {
      cwd: plan.appRoot,
      env: environmentForExecutable(plan.executable),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const collect = (chunk: Buffer | string) => {
      this.pending += String(chunk);
      const pieces = this.pending.split(/\r?\n/);
      this.pending = pieces.pop() ?? "";
      for (const line of pieces) this.addLine(line);
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
    const child = this.child;
    const pid = child?.pid;
    if (!child || !pid) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try { process.kill(-pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    if (!graceful) {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
  }
}

export async function waitForHttp(origin: string, timeoutMs: number, aborted: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "No response";
  while (Date.now() < deadline) {
    if (aborted()) throw new Error("Development server stopped before it became ready.");
    try {
      const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(1_500) });
      if (response.status >= 200 && response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out waiting for ${origin}: ${lastError}`);
}
