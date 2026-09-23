import path from "node:path";
import { randomUUID } from "node:crypto";
import { isCanvasState, type CanvasState } from "./canvas-state";
import type {
  ActiveWorkspace,
  ConfirmProjectRequest,
  LaunchPlan,
  ProjectDiscovery,
  WorkspaceEvent,
} from "./project-contract";
import { OwnedDevProcess, availablePort, existingNextServer, withSessionPort, isPortOccupied, waitForHttp } from "../infrastructure/project/dev-process";
import { discoverProject, validateStartPath } from "../infrastructure/project/discovery";
import { WorkspaceStore } from "../infrastructure/project/workspace-store";
import { JournalStore } from "../infrastructure/instrumentation/journal";
import {
  applyIntegration,
  cleanupIntegration,
  prepareIntegrationPlan,
  transactionIdFor,
  type IntegrationPlan,
} from "../infrastructure/instrumentation/plan";

interface ActiveInternal {
  value: ActiveWorkspace;
  plan: LaunchPlan;
  integration: IntegrationPlan;
  process: OwnedDevProcess | null;
  bridgeTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

export class WorkspaceManager {
  private active: ActiveInternal | null = null;
  private discovery: ProjectDiscovery | null = null;
  private recoveryConflicts: string[] = [];
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();

  constructor(
    private readonly journals: JournalStore,
    private readonly workspaces: WorkspaceStore,
    private readonly bridgeEntry?: string,
  ) {}

  async initialize(): Promise<void> {
    const conflicts: string[] = [];
    let journals;
    try { journals = await this.journals.list(); }
    catch (error) {
      conflicts.push(error instanceof Error ? error.message : String(error));
      this.recoveryConflicts = conflicts;
      this.emit();
      return;
    }
    for (const journal of journals) {
      if (journal.state === "clean") continue;
      try {
        const result = await cleanupIntegration(journal.transactionId, this.journals);
        conflicts.push(...result.conflicts);
      } catch (error) {
        conflicts.push(`Could not recover ${journal.workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.recoveryConflicts = conflicts;
    this.emit();
  }

  snapshot(): WorkspaceEvent {
    return { active: this.active ? structuredClone(this.active.value) : null, recoveryConflicts: [...this.recoveryConflicts] };
  }

  subscribe(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const event = this.snapshot();
    for (const listener of this.listeners) listener(event);
  }

  async inspect(selectedPath: string): Promise<ProjectDiscovery> {
    if (this.active) throw new Error("Close the active project before opening another one.");
    const initial = await discoverProject(selectedPath);
    const remembered = await this.workspaces.rememberedPlan(initial.canonicalRoot);
    this.discovery = remembered ? await discoverProject(selectedPath, remembered) : initial;
    const startPath = await this.workspaces.startPath(initial.canonicalRoot);
    if (startPath) for (const plan of this.discovery.plans) plan.startPath = validateStartPath(startPath);
    return structuredClone(this.discovery);
  }

  async confirm(request: ConfirmProjectRequest): Promise<ActiveWorkspace> {
    if (this.active) throw new Error("Only one project can be active.");
    if (!this.discovery || request.discoveryId !== this.discovery.discoveryId) throw new Error("This project plan is stale. Inspect the folder again.");
    const selectedPlan = this.discovery.plans.find((candidate) => candidate.id === request.planId);
    if (!selectedPlan) throw new Error("Unknown launch plan.");
    const refreshed = await discoverProject(this.discovery.selectedRoot);
    let plan = refreshed.plans.find((candidate) => candidate.id === selectedPlan.id);
    if (!plan) throw new Error("The manifest, lockfile, development script, or integration plan changed. Inspect and confirm the project again.");
    const blocker = plan.diagnostics.find((item) => item.level === "error");
    if (blocker) throw new Error(blocker.message);
    if (!plan.dependenciesPresent) throw new Error("Project dependencies are missing. Mauxi will not install them.");
    if (!plan.integration.supported) throw new Error(plan.integration.summary);

    if (request.mode === "attach" && plan.framework === "next") throw new Error("Next.js needs a Mauxi-owned server to isolate and clean its build cache. Choose Confirm & start; external servers remain untouched.");
    if (plan.framework === "next" && await existingNextServer(plan.appRoot)) throw new Error("This Next.js project already has a development server running. Close it before importing so it cannot compile Mauxi hooks into its own cache. Mauxi did not stop it.");
    const occupied = await isPortOccupied(plan.port);
    if (request.mode === "start") plan = withSessionPort(plan, occupied ? await availablePort() : plan.port);
    plan.startPath = validateStartPath(request.startPath ?? selectedPlan.startPath ?? plan.startPath ?? "/");
    if (request.mode === "attach" && !occupied) throw new Error(`Nothing is listening on ${plan.origin}; attachment was not started.`);

    const integration = await prepareIntegrationPlan(plan.appRoot, plan.framework, request.mode === "start");
    const active: ActiveInternal = {
      plan,
      integration,
      process: null,
      bridgeTimer: null,
      closing: false,
      value: {
        workspaceId: randomUUID(),
        canvas: await this.workspaces.canvas(plan.projectRoot),
        projectRoot: plan.projectRoot,
        appRoot: plan.appRoot,
        framework: plan.framework,
        packageManager: plan.packageManager,
        commandDisplay: plan.commandDisplay,
        origin: plan.origin,
        startPath: plan.startPath ?? "/",
        ownership: request.mode === "start" ? "owned" : "attached",
        status: "preparing",
        statusDetail: "Recording recovery intent before temporary setup…",
        logs: [],
        connectedPreviews: [],
        cleanupConflicts: [],
      },
    };
    this.active = active;
    this.emit();

    try {
      await applyIntegration(integration, this.journals, this.bridgeEntry);
      if (request.mode === "start") {
        active.value.status = "starting";
        active.value.statusDetail = `Starting ${plan.commandDisplay}…`;
        active.process = new OwnedDevProcess(
          (line) => {
            active.value.logs.push(line);
            if (active.value.logs.length > 400) active.value.logs.splice(0, active.value.logs.length - 400);
            this.emit();
          },
          (code, signal) => {
            if (active.closing) return;
            active.value.status = "failed";
            active.value.statusDetail = `Development server exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`;
            this.emit();
          },
        );
        active.process.start(plan, integration.runtimeDirectory ? path.join(plan.appRoot, ".mauxi/launcher.cjs") : undefined);
      } else {
        active.value.logs.push(`Attached to ${plan.origin}. The external process remains user-owned.`);
      }
      active.value.status = "waiting-for-server";
      active.value.statusDetail = `Waiting for ${plan.origin}…`;
      this.emit();
      // An attached Vite server can answer with its old config while the file
      // watcher is about to restart it. Wait for the instrumented HTML before
      // creating previews, or their initial script requests can be interrupted.
      await waitForHttp(new URL(plan.startPath ?? "/", plan.origin).href, 45_000,
        () => !this.active || this.active !== active || (request.mode === "start" && active.process?.pid == null),
        plan.framework === "vite" ? ".mauxi/bridge.js" : undefined);
      active.value.status = "connecting-previews";
      active.value.statusDetail = request.mode === "attach"
        ? "Server responded. Waiting for its preview bridge; restart the external server if its config was already loaded."
        : "Server responded. Waiting for both preview bridges…";
      active.bridgeTimer = setTimeout(() => {
        if (active.closing || active.value.connectedPreviews.length === 2) return;
        active.value.status = "failed";
        active.value.statusDetail = `The server at ${plan.origin} responded, but the Mauxi bridge did not connect in both previews. Check the URL, compiler output, and integration setup.`;
        this.emit();
      }, 30_000);
      await this.workspaces.remember(plan.projectRoot, plan.id, plan.startPath);
      this.emit();
      return structuredClone(active.value);
    } catch (error) {
      active.value.status = "failed";
      active.value.statusDetail = error instanceof Error ? error.message : String(error);
      this.emit();
      let cleanupComplete = false;
      try {
        active.closing = true;
        if (active.bridgeTimer) clearTimeout(active.bridgeTimer);
        active.bridgeTimer = null;
        await active.process?.stop();
        const cleanup = await cleanupIntegration(transactionIdFor(integration), this.journals);
        active.value.cleanupConflicts = cleanup.conflicts;
        this.recoveryConflicts = [...new Set([...this.recoveryConflicts, ...cleanup.conflicts])];
        cleanupComplete = cleanup.state === "clean";
      } catch (cleanupError) {
        // ENOENT may describe a missing owned artifact, not a missing journal.
        // Only a setup that never recorded intent can be treated as untouched.
        if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") {
          try { await this.journals.read(transactionIdFor(integration)); }
          catch (journalError) { cleanupComplete = (journalError as NodeJS.ErrnoException).code === "ENOENT"; }
        }
        if (!cleanupComplete) this.recoveryConflicts.push(`Setup cleanup failed for ${plan.appRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      if (cleanupComplete) this.active = null;
      else active.closing = false;
      this.emit();
      throw error;
    }
  }

  bridgeReady(workspaceId: string, previewId: "desktop" | "mobile", generation: string, url: string): void {
    const active = this.active;
    if (!active || active.value.workspaceId !== workspaceId) throw new Error("Stale workspace bridge.");
    if (!generation || generation.length > 128) throw new Error("Invalid bridge generation.");
    if (new URL(url).origin !== new URL(active.value.origin).origin) throw new Error("Unexpected preview origin.");
    if (!active.value.connectedPreviews.includes(previewId)) active.value.connectedPreviews.push(previewId);
    if (active.value.connectedPreviews.length === 2) {
      if (active.bridgeTimer) clearTimeout(active.bridgeTimer);
      active.bridgeTimer = null;
      active.value.status = "ready";
      active.value.statusDetail = "Two live previews are connected.";
    } else {
      active.value.status = "connecting-previews";
      active.value.statusDetail = `Connected ${previewId}; waiting for the other preview…`;
    }
    this.emit();
  }

  async saveCanvas(workspaceId: string, canvas: CanvasState): Promise<void> {
    const active = this.active;
    if (!active || active.value.workspaceId !== workspaceId || !isCanvasState(canvas)) throw new Error("Invalid or stale canvas layout");
    await this.workspaces.saveCanvas(active.value.projectRoot, canvas);
    active.value.canvas = structuredClone(canvas);
  }

  async close(): Promise<WorkspaceEvent> {
    const active = this.active;
    if (!active) return this.snapshot();
    active.closing = true;
    if (active.bridgeTimer) clearTimeout(active.bridgeTimer);
    active.bridgeTimer = null;
    active.value.status = "stopped";
    active.value.statusDetail = "Stopping owned work and removing temporary integration…";
    this.emit();
    try {
      await active.process?.stop();
      const result = await cleanupIntegration(transactionIdFor(active.integration), this.journals);
      active.value.cleanupConflicts = result.conflicts;
      if (result.conflicts.length) {
        this.recoveryConflicts = [...new Set([...this.recoveryConflicts, ...result.conflicts])];
        throw new Error(`Cleanup needs attention: ${result.conflicts.join("; ")}`);
      }
      this.active = null;
      this.discovery = null;
      this.emit();
      return this.snapshot();
    } catch (error) {
      active.value.status = "failed";
      active.value.statusDetail = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }
}
