import { assertBrowserRequest, type BrowserPort, type BrowserRequest, type BrowserResult, type BrowserState, type BrowserTarget, type BrowserOwner, type BrowserActionTarget } from "./browser-contract";

export interface VisibleBrowserAdapter {
  targets(): Promise<BrowserTarget[]>;
  describeTarget(request: BrowserRequest, signal: AbortSignal): Promise<BrowserActionTarget>;
  execute(request: BrowserRequest, signal: AbortSignal, approvedTarget?: BrowserActionTarget): Promise<BrowserResult>;
  release?(): Promise<void>;
}

type Approval = (request: BrowserRequest, signal: AbortSignal, target?: BrowserActionTarget) => Promise<boolean>;

export class BrowserControl implements BrowserPort {
  private value: BrowserState;
  private controller = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;
  private releasing = 0;
  private captures = 0;
  private listeners = new Set<(state: BrowserState) => void>();
  constructor(readonly workspaceId: string, private adapter: VisibleBrowserAdapter, private approve: Approval) {
    this.value = { workspaceId, owner: "human", generation: 0, releasing: false, activity: "You control the previews", remaining: 24, evidence: [] };
  }
  state(): BrowserState { return structuredClone(this.value); }
  subscribe(listener: (state: BrowserState) => void) { this.listeners.add(listener);

  return () => { this.listeners.delete(listener); }; }
  private publish() { for (const listener of this.listeners) listener(this.state()); }
  async targets() { return this.adapter.targets(); }
  grant() {
    if (this.value.releasing || this.value.owner === "agent") throw new Error("Browser control is busy");
    this.controller.abort(); this.controller = new AbortController();
    this.value.owner = "agent"; this.value.generation++; this.value.activity = "Agent controls both previews"; this.publish();
  }
  humanOwner(owner: Exclude<BrowserOwner, "agent">) {
    this.revoke(owner === "picker" ? "Picker controls the previews" : "You control the previews");
    this.value.owner = owner; this.publish();
  }
  revoke(reason: string) {
    this.controller.abort(new Error(reason));
    this.value.generation++; this.value.owner = "human";
    this.value.releasing = this.active > 0 || !!this.adapter.release; this.value.activity = reason; this.publish();

    if (this.adapter.release) {
      const revision = ++this.releasing;
      void this.tail.then(() => this.adapter.release!()).catch(() => undefined).finally(() => {
        if (revision === this.releasing) { this.value.releasing = this.active > 0; this.publish(); }
      });
    }
  }
  resetBudget() { this.captures = 0; this.value.remaining = 24; this.value.evidence = []; this.publish(); }
  private check(r: BrowserRequest, signal: AbortSignal) {
    signal.throwIfAborted();

    if (r.workspaceId !== this.workspaceId || r.generation !== this.value.generation || this.value.owner !== "agent") throw new Error("Browser control revoked or stale; request a new handoff");
  }
  async run(input: BrowserRequest, external?: AbortSignal): Promise<BrowserResult> {
    assertBrowserRequest(input);
    const r = structuredClone(input);
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(60_000), ...(external ? [external] : [])]);
    this.check(r, signal);

    if (this.value.remaining <= 0) { this.revoke("Verification budget reached; start a new request to continue"); throw new Error("Verification budget reached (24 calls per run)"); }

    if (r.operation === "screenshot" && ++this.captures > 4) { this.revoke("Screenshot budget reached (4 per run)"); throw new Error("Screenshot budget reached (4 per run)"); }

    this.value.remaining--; this.publish();
    const evidenceId = `${r.generation}-${this.value.remaining}`;

    const result = this.tail.then(async () => {
      this.check(r, signal); this.active++;

      try {
        const validate = async () => {
          const targets = await this.adapter.targets(); this.check(r, signal);

          if (!targets.some(t => t.workspaceId === r.workspaceId && t.previewId === r.previewId && t.documentId === r.documentId && t.url === r.url)) throw new Error("Stale browser document; inspect current targets");
        };

        await validate();
        this.value.activity = `${r.operation} · ${r.previewId}`; this.publish();
        let approvedTarget: BrowserActionTarget | undefined;

        if (!["inspect", "source", "console", "screenshot"].includes(r.operation)) {
          if (["click", "type", "hover"].includes(r.operation)) approvedTarget = structuredClone(await this.adapter.describeTarget(r, signal));
          this.check(r, signal);

          if (!await this.approve(r, signal, approvedTarget && structuredClone(approvedTarget))) throw new Error("Browser action denied; nothing was executed");
          await validate();
        }

        this.check(r, signal);
        const observation = await this.adapter.execute(r, signal, approvedTarget);
        this.value.evidence.push({ id: evidenceId, previewId: r.previewId, documentId: r.documentId, operation: r.operation, at: new Date().toISOString(), summary: observation.text.slice(0, 1600), image: observation.image });
        this.value.evidence = this.value.evidence.slice(-24);

        return observation;
      } catch (error) { this.revoke(`Control returned: ${error instanceof Error ? error.message : String(error)}`); throw error; }
      finally { this.active--;

      if (!this.adapter.release) this.value.releasing = this.active > 0 && this.value.owner !== "agent";

      if (this.value.owner === "agent") this.value.activity = "Agent controls both previews"; this.publish(); }
    });

    this.tail = result.catch(() => undefined);

    return result;
  }
}
