import { BrowserWindow, type Session } from "electron";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import axeSource from "axe-core/axe.min.js" with { type: "text" };
import { AXE_IGNORED_INCOMPLETE, AXE_NODE_LIMIT, AXE_RULES, AXE_TIMEOUT_MS, isAxeRun, type AxeProfileResult, type AxeRun, type AxeRunOptions } from "../../application/audit-axe";
import { AUDIT_PROFILES, isPageMeasurement, SWEEP_HEIGHT, sweepWidths, type AuditAxeInfo, type AuditProgress, type AuditReport, type AuditSnapshot, type PageMeasurement, type RouteDiscovery } from "../../application/audit-contract";
import { INTERACTION_PROFILE_IDS, isInteractionResult, type InteractionRun } from "../../application/audit-interactions";
import { buildReport, type AuditSample } from "../../application/audit-report";
import { runAxe } from "./axe-run";
import { runInteractionPass } from "./interaction-pass";
import { confine, type Fence } from "./navigation-fence";
import { measurePage } from "./page-audit";
import { interactionStep } from "./page-interactions";
import { discoverRoutes, type DiscoveryRequest } from "./route-discovery";

const EvaluateResult = Type.Object({ result: Type.Object({ value: Type.Optional(Type.Unknown()) }), exceptionDetails: Type.Optional(Type.Object({ text: Type.Optional(Type.String()), exception: Type.Optional(Type.Object({ description: Type.Optional(Type.String()) })) })) });
const Screenshot = Type.Object({ data: Type.String() });
const FrameTree = Type.Object({ frameTree: Type.Object({ frame: Type.Object({ id: Type.String() }) }) });
const IsolatedWorld = Type.Object({ executionContextId: Type.Integer() });

type CdpValue = string | number | boolean | CdpValue[] | { [key: string]: CdpValue };

type CdpParams = { [key: string]: CdpValue };

const MEASURE = `(${measurePage.toString()})`;
const INTERACT = `(${interactionStep.toString()})`;
const RUN_AXE = `(${runAxe.toString()})`;
const AXE_OPTIONS: AxeRunOptions = { rules: AXE_RULES, maxNodes: AXE_NODE_LIMIT, timeoutMs: AXE_TIMEOUT_MS, ignoredIncomplete: AXE_IGNORED_INCOMPLETE };
const SNAPSHOT_MAX_HEIGHT = 2_400;
const RUN_LIMIT_MS = 180_000;
const DISCOVERY_LIMIT_MS = 45_000;
const STATIC_STYLE = "*,*::before,*::after{transition:none!important;animation-play-state:paused!important;caret-color:transparent!important;scroll-behavior:auto!important}";
const SPACING_STYLE = "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";

/**
 * Next.js hydrates after the load event (App Router hydrates the whole document, Pages Router #__next). Until then elements
 * carry no React fibers, so source hints are missing and client effects can still change the layout. Other pages resolve at once.
 */
const HYDRATED = `new Promise(resolve => {
  const fiber = element => !!element && Object.keys(element).some(key => key.startsWith("__reactFiber$"));
  const pages = document.getElementById("__next");
  const done = () => "__next_f" in self ? fiber(document.body) : pages && "__NEXT_DATA__" in self ? fiber(pages.firstElementChild) : true;
  const deadline = Date.now() + 10000;
  const tick = () => done() || Date.now() > deadline ? resolve(true) : setTimeout(tick, 50);
  tick();
})`;

function sameOrigin(value: string, origin: string): boolean {
  try { return new URL(value).origin === new URL(origin).origin; } catch { return false; }
}

/** snapshotScale below 1 captures snapshots at reduced resolution (site audits), keeping CSS-pixel geometry. */
export interface AuditScanRequest { url: string; route: string; origin: string; previous: AuditReport | null; snapshotScale?: number }

/**
 * Loads one project route in a hidden window that shares the workspace session, then measures it across the
 * width sweep and the full-check profiles with CDP viewport emulation. The visible previews are never resized.
 */
export class AuditScanner {
  private controller?: AbortController;

  constructor(private readonly options: { session: () => Session; onProgress: (progress: AuditProgress) => void }) {}

  get running(): boolean { return !!this.controller; }

  cancel(reason = "Audit cancelled"): void { this.controller?.abort(new Error(reason)); }

  run(request: AuditScanRequest): Promise<AuditReport> {
    return this.exclusive(request, RUN_LIMIT_MS, "The audit exceeded its time limit.", (window, signal, fence) => this.scan(window, request, signal, fence));
  }

  /** Lists same-origin pages linked from the starting route, for a site audit. Shares the one-run-at-a-time lock. */
  discover(request: DiscoveryRequest): Promise<RouteDiscovery> {
    return this.exclusive(request, DISCOVERY_LIMIT_MS, "Route discovery exceeded its time limit.", (window, signal, fence) => discoverRoutes(window, request, signal, fence));
  }

  private async exclusive<T>(request: { url: string; origin: string }, limitMs: number, timeout: string, work: (window: BrowserWindow, signal: AbortSignal, fence: Fence) => Promise<T>): Promise<T> {
    if (this.controller) throw new Error("An audit is already running.");

    if (!sameOrigin(request.url, request.origin)) throw new Error("Audits are limited to the approved project origin.");
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error(timeout)), limitMs);

    const window = new BrowserWindow({
      show: false, width: 1440, height: SWEEP_HEIGHT,
      // Offscreen rendering keeps painting and CDP emulation working without a visible or hidden native window.
      webPreferences: { offscreen: true, session: this.options.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, backgroundThrottling: false },
    });

    const fence = confine(window, request.origin, request.url);

    try { return await work(window, controller.signal, fence); }
    finally {
      clearTimeout(timer);
      this.controller = undefined;

      if (!window.isDestroyed()) window.destroy();
    }
  }

  private async scan(window: BrowserWindow, request: AuditScanRequest, signal: AbortSignal, fence: Fence): Promise<AuditReport> {
    const started = Date.now();
    const contents = window.webContents;
    const allowed = (target: string) => sameOrigin(target, request.origin);
    // While the interaction pass clicks and presses keys, every navigation of the audit window is blocked and counted.
    const interaction = { active: false, blocked: 0 };

    const guard = (event: Electron.Event, target: string) => {
      if (allowed(target) && !interaction.active) return;
      event.preventDefault();

      if (interaction.active) interaction.blocked++;
    };

    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-frame-navigate", (event) => { if (event.isMainFrame) guard(event, event.url); });
    const debug = contents.debugger;
    let reloaded = false;
    debug.attach("1.3");

    const query = async <T extends TSchema>(schema: T, method: string, params: CdpParams = {}): Promise<Static<T>> => {
      signal.throwIfAborted();

      if (window.isDestroyed()) throw new Error("The audit window closed.");
      const result = await debug.sendCommand(method, params);

      if (!Value.Check(schema, result)) throw new Error(`Unexpected ${method} response.`);

      return result;
    };

    const command = async (method: string, params: CdpParams = {}): Promise<void> => { await query(Type.Unknown(), method, params); };

    const evaluate = async (expression: string, contextId?: number): Promise<Static<typeof EvaluateResult>["result"]> => {
      const result = await query(EvaluateResult, "Runtime.evaluate", contextId === undefined ? { expression, returnByValue: true, awaitPromise: true } : { expression, returnByValue: true, awaitPromise: true, contextId });

      if (result.exceptionDetails) throw new Error(`${contextId === undefined ? "Page measurement" : "axe-core"} failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown error"}`.slice(0, 600));

      return result.result;
    };

    const resize = async (width: number, height: number, settleMs: number) => {
      await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`new Promise(resolve => setTimeout(resolve, ${settleMs}))`);
    };

    const measure = async (full: boolean, targets?: string[]): Promise<PageMeasurement> => {
      if (reloaded) throw new Error("The page reloaded during the audit (for example a dev server full reload). Run the audit again.");
      const { value } = await evaluate(`${MEASURE}(${JSON.stringify({ full, maxElements: 6_000, targets })})`);

      if (!isPageMeasurement(value)) throw new Error("The page returned an invalid measurement.");

      return value;
    };

    const sweep = sweepWidths();
    const interactionProfiles = INTERACTION_PROFILE_IDS.flatMap((id) => AUDIT_PROFILES.filter((profile) => profile.id === id));
    const total = sweep.length + AUDIT_PROFILES.length + interactionProfiles.length;

    const progress = (phase: AuditProgress["phase"], done: number, width?: number) => {
      const update: AuditProgress = { phase, done, total };

      if (width) update.width = width;
      this.options.onProgress(update);
    };

    progress("loading", 0);
    const loaded = window.loadURL(request.url);
    const aborted = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

    try { await Promise.race([loaded, aborted]); }
    catch (error) {
      signal.throwIfAborted();

      if (!fence.refused) throw error;
    }

    signal.throwIfAborted();

    if (fence.refused) throw new Error(fence.refused.route === null ? "The audited page left the approved project origin." : `The page redirects to an excluded route (${fence.refused.reason}).`);

    if (!allowed(contents.getURL())) throw new Error("The audited page left the approved project origin.");
    // A dev server full reload (HMR fallback) would replace the document mid-scan and drop the injected styles.
    contents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) reloaded = true; });
    await evaluate(HYDRATED);
    // Emulation is applied only after the first document exists; overriding metrics on the initial blank page is unstable.
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate(`Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]).then(() => new Promise(r => setTimeout(r, 400)))`);
    await evaluate(`(() => { const style = document.createElement("style"); style.dataset.mauxiOverlay = "true"; style.id = "mauxi-audit-static"; style.textContent = ${JSON.stringify(STATIC_STYLE)}; document.head.append(style); })()`);

    // axe-core runs in an isolated world: page scripts cannot tamper with it and it never touches the page's globals.
    // React fiber expandos are invisible there, so its targets are described by measurePage in the main world.
    const axe: AuditAxeInfo = { version: null, profiles: [], durationMs: 0, note: null };
    const axeFailed = (where: string, cause: unknown) => { axe.note ??= `General checks (axe-core) ${where}: ${(cause instanceof Error ? cause.message : String(cause)).replace(/^axe-core failed: (?:Error: )?/, "").split("\n")[0]}`.slice(0, 600); };
    let axeContext: number | null = null;

    try {
      const { frameTree } = await query(FrameTree, "Page.getFrameTree");
      axeContext = (await query(IsolatedWorld, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "mauxi-axe" })).executionContextId;
      await evaluate(`${axeSource};undefined`, axeContext);
    } catch (error) { signal.throwIfAborted(); axeContext = null; axeFailed("could not start", error); }

    const runAxeHere = async (label: string): Promise<AxeRun | null> => {
      if (axeContext === null) return null;

      try {
        const { value } = await evaluate(`${RUN_AXE}(axe, ${JSON.stringify(AXE_OPTIONS)})`, axeContext);

        if (!isAxeRun(value)) throw new Error("axe-core returned an invalid result.");
        axe.version = value.version;
        axe.durationMs += value.durationMs;

        return value;
      } catch (error) {
        signal.throwIfAborted();
        axeFailed(`failed at ${label}`, error);

        return null;
      }
    };

    const samples: AuditSample[] = [];
    let done = 0;

    for (const width of sweep) {
      progress("sweep", done, width);
      await resize(width, SWEEP_HEIGHT, 60);
      samples.push({ width, height: SWEEP_HEIGHT, profile: null, measurement: await measure(false) });
      done++;
    }

    const snapshots: AuditSnapshot[] = [];

    for (const profile of AUDIT_PROFILES) {
      progress("profiles", done, profile.width);

      if (profile.textSpacing) await evaluate(`(() => { const style = document.createElement("style"); style.dataset.mauxiOverlay = "true"; style.id = "mauxi-audit-spacing"; style.textContent = ${JSON.stringify(SPACING_STYLE)}; document.head.append(style); })()`);
      await resize(profile.width, profile.height, 250);
      // axe runs once per distinct layout: text-spacing overrides and the short 400% zoom viewport repeat a measured width.
      const axeRun = profile.textSpacing || profile.viewportOnly ? null : await runAxeHere(profile.label);
      const targets = [...new Set(axeRun?.results.flatMap((result) => result.nodes.flatMap((node) => node.target.includes(" >>> ") ? [] : [node.target])) ?? [])].slice(0, 200);
      const measurement = await measure(true, axeRun ? targets : undefined);
      const sample: AuditSample = { width: profile.width, height: profile.height, profile, measurement };

      if (axeRun) {
        sample.axe = axeRun.results.map((result): AxeProfileResult => ({ ...result, nodes: result.nodes.map((node) => ({ ...node, element: measurement.targets?.[targets.indexOf(node.target)] ?? null })) }));
        axe.profiles.push(profile.id);
      }

      samples.push(sample);

      if (profile.snapshot) {
        const imageHeight = profile.viewportOnly ? profile.height : Math.max(profile.height, Math.min(SNAPSHOT_MAX_HEIGHT, Math.ceil(measurement.documentHeight)));
        const shot = await query(Screenshot, "Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: !profile.viewportOnly, clip: { x: 0, y: 0, width: profile.width, height: imageHeight, scale: request.snapshotScale ?? 1 } });
        const snapshot: AuditSnapshot = { profileId: profile.id, label: profile.label, width: profile.width, height: profile.height, imageHeight, image: `data:image/jpeg;base64,${shot.data}` };

        if (profile.note) snapshot.note = profile.note;
        snapshots.push(snapshot);
      }

      if (profile.textSpacing) await evaluate(`document.getElementById("mauxi-audit-spacing")?.remove()`);
      done++;
    }

    const settle = (ms: number) => evaluate(`Promise.race([new Promise(r => requestAnimationFrame(() => ${ms ? `requestAnimationFrame(() => setTimeout(r, ${ms}))` : "r()"})), new Promise(r => setTimeout(r, ${ms + 300}))])`);

    const mouse = async (types: string[], point: { x: number; y: number }) => {
      for (const type of types) await command("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    };

    interaction.active = true;

    const interactions: InteractionRun = await runInteractionPass({
      step: async (step) => {
        if (reloaded) throw new Error("the page reloaded during the interaction checks");
        const { value } = await evaluate(`${INTERACT}(${JSON.stringify(step)})`);

        if (!isInteractionResult(value)) throw new Error(`The page returned an invalid ${step.action} result.`);

        return value;
      },
      press: async (key) => {
        const code = key === "Tab" ? 9 : 27;

        for (const type of ["rawKeyDown", "keyUp"]) await command("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      },
      click: (point) => mouse(["mouseMoved", "mousePressed", "mouseReleased"], point),
      hover: (point) => mouse(["mouseMoved"], point),
      settle: async (ms) => { await settle(ms); },
      resize: (width, height) => resize(width, height, 250),
      capture: async () => `data:image/jpeg;base64,${(await query(Screenshot, "Page.captureScreenshot", { format: "jpeg", quality: 72 })).data}`,
      blockedNavigations: () => interaction.blocked,
    }, interactionProfiles, signal, (profile) => { progress("interactions", done, profile.width); done++; }).finally(() => { interaction.active = false; });

    if (!allowed(contents.getURL())) throw new Error("The audited page left the approved project origin.");
    progress("done", total);

    if (axeContext !== null && !axe.profiles.length) axe.note ??= "General checks (axe-core) did not run at any profile.";

    return buildReport({ url: request.url, route: request.route, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, samples, snapshots, previous: request.previous, interactions, axe });
  }
}
