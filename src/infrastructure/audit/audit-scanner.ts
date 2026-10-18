import { BrowserWindow, type Session } from "electron";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { AUDIT_PROFILES, isPageMeasurement, SWEEP_HEIGHT, sweepWidths, type AuditProgress, type AuditReport, type AuditSnapshot, type PageMeasurement } from "../../application/audit-contract";
import { INTERACTION_PROFILE_IDS, isInteractionResult, type InteractionRun } from "../../application/audit-interactions";
import { buildReport, type AuditSample } from "../../application/audit-report";
import { runInteractionPass } from "./interaction-pass";
import { measurePage } from "./page-audit";
import { interactionStep } from "./page-interactions";

const EvaluateResult = Type.Object({ result: Type.Object({ value: Type.Optional(Type.Unknown()) }), exceptionDetails: Type.Optional(Type.Object({ text: Type.Optional(Type.String()), exception: Type.Optional(Type.Object({ description: Type.Optional(Type.String()) })) })) });
const Screenshot = Type.Object({ data: Type.String() });

type CdpValue = string | number | boolean | CdpValue[] | { [key: string]: CdpValue };

type CdpParams = { [key: string]: CdpValue };

const MEASURE = `(${measurePage.toString()})`;
const INTERACT = `(${interactionStep.toString()})`;
const SNAPSHOT_MAX_HEIGHT = 2_400;
const RUN_LIMIT_MS = 180_000;
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

export interface AuditScanRequest { url: string; route: string; origin: string; previous: AuditReport | null }

/**
 * Loads one project route in a hidden window that shares the workspace session, then measures it across the
 * width sweep and the full-check profiles with CDP viewport emulation. The visible previews are never resized.
 */
export class AuditScanner {
  private controller?: AbortController;

  constructor(private readonly options: { session: () => Session; onProgress: (progress: AuditProgress) => void }) {}

  get running(): boolean { return !!this.controller; }

  cancel(reason = "Audit cancelled"): void { this.controller?.abort(new Error(reason)); }

  async run(request: AuditScanRequest): Promise<AuditReport> {
    if (this.controller) throw new Error("An audit is already running.");

    if (!sameOrigin(request.url, request.origin)) throw new Error("Audits are limited to the approved project origin.");
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("The audit exceeded its time limit.")), RUN_LIMIT_MS);

    const window = new BrowserWindow({
      show: false, width: 1440, height: SWEEP_HEIGHT,
      // Offscreen rendering keeps painting and CDP emulation working without a visible or hidden native window.
      webPreferences: { offscreen: true, session: this.options.session(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, backgroundThrottling: false },
    });

    try { return await this.scan(window, request, controller.signal); }
    finally {
      clearTimeout(timer);
      this.controller = undefined;

      if (!window.isDestroyed()) window.destroy();
    }
  }

  private async scan(window: BrowserWindow, request: AuditScanRequest, signal: AbortSignal): Promise<AuditReport> {
    const started = Date.now();
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
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

    const evaluate = async (expression: string): Promise<Static<typeof EvaluateResult>["result"]> => {
      const result = await query(EvaluateResult, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });

      if (result.exceptionDetails) throw new Error(`Page measurement failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown error"}`.slice(0, 600));

      return result.result;
    };

    const resize = async (width: number, height: number, settleMs: number) => {
      await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`new Promise(resolve => setTimeout(resolve, ${settleMs}))`);
    };

    const measure = async (full: boolean): Promise<PageMeasurement> => {
      if (reloaded) throw new Error("The page reloaded during the audit (for example a dev server full reload). Run the audit again.");
      const { value } = await evaluate(`${MEASURE}(${JSON.stringify({ full, maxElements: 6_000 })})`);

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
    await Promise.race([loaded, aborted]);
    signal.throwIfAborted();

    if (!allowed(contents.getURL())) throw new Error("The audited page left the approved project origin.");
    // A dev server full reload (HMR fallback) would replace the document mid-scan and drop the injected styles.
    contents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) reloaded = true; });
    await evaluate(HYDRATED);
    // Emulation is applied only after the first document exists; overriding metrics on the initial blank page is unstable.
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate(`Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise(r => setTimeout(r, 3000))]).then(() => new Promise(r => setTimeout(r, 400)))`);
    await evaluate(`(() => { const style = document.createElement("style"); style.dataset.mauxiOverlay = "true"; style.id = "mauxi-audit-static"; style.textContent = ${JSON.stringify(STATIC_STYLE)}; document.head.append(style); })()`);

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
      const measurement = await measure(true);
      samples.push({ width: profile.width, height: profile.height, profile, measurement });

      if (profile.snapshot) {
        const imageHeight = profile.viewportOnly ? profile.height : Math.max(profile.height, Math.min(SNAPSHOT_MAX_HEIGHT, Math.ceil(measurement.documentHeight)));
        const shot = await query(Screenshot, "Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: !profile.viewportOnly, clip: { x: 0, y: 0, width: profile.width, height: imageHeight, scale: 1 } });
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

    return buildReport({ url: request.url, route: request.route, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, samples, snapshots, previous: request.previous, interactions });
  }
}
