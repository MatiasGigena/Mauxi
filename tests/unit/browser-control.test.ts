import { describe, expect, it, vi } from "vitest";
import { BrowserControl, type VisibleBrowserAdapter } from "../../src/application/browser-control";
import { assertBrowserRequest, type BrowserRequest, type BrowserTarget, type BrowserActionTarget } from "../../src/application/browser-contract";
import { isBridgeMessage, isShellMessage } from "../../src/application/preview-contract";

const target: BrowserTarget = { workspaceId: "workspace", previewId: "desktop", documentId: "document", url: "http://localhost:3000/" };
const actionTarget: BrowserActionTarget = { tag: "button", text: "Delete fixture record", label: "Delete fixture record", role: "button", testId: "delete-record", type: "button", bounds: { x: 20, y: 30, width: 100, height: 40 } };

function setup(approve: (request: BrowserRequest, signal: AbortSignal, target?: BrowserActionTarget) => Promise<boolean> = async () => true) {
  const adapter: VisibleBrowserAdapter = { targets: vi.fn(async () => [target]), describeTarget: vi.fn(async () => structuredClone(actionTarget)), execute: vi.fn(async () => ({ text: "actual observation" })) };
  const control = new BrowserControl("workspace", adapter, vi.fn(approve));
  control.grant();

  const request = (operation: BrowserRequest["operation"] = "inspect"): BrowserRequest => {
    const value: BrowserRequest = { ...target, generation: control.state().generation, operation };

    if (operation === "click") value.target = "node-1";

    return value;
  };

  return { adapter, control, request };
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; });

return { promise, resolve }; }

describe("visible browser host ownership", () => {
  it("serializes both previews and records only completed actual checks", async () => {
    const { adapter, control, request } = setup();
    const pending = deferred<{ text: string }>();
    vi.mocked(adapter.execute).mockImplementationOnce(() => pending.promise);
    vi.mocked(adapter.targets).mockResolvedValue([target, { ...target, previewId: "mobile", documentId: "mobile-document" }]);
    const a = control.run(request()); const b = control.run({ ...request("console"), previewId: "mobile", documentId: "mobile-document" });
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalledTimes(1));
    expect(control.state().evidence).toHaveLength(0);
    pending.resolve({ text: "desktop DOM read" }); await Promise.all([a, b]);
    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.execute).mock.calls.map(([request]) => request.previewId)).toEqual(["desktop", "mobile"]);
    expect(control.state().evidence.map(e => e.summary)).toEqual(["desktop DOM read", "actual observation"]);
  });
  it("revocation invalidates queued/new actions, drains in-flight work before human input resumes", async () => {
    const { adapter, control, request } = setup();
    const pending = deferred<{ text: string }>();
    vi.mocked(adapter.execute).mockImplementationOnce(() => pending.promise);
    const old = request(); const a = control.run(old); const b = control.run(old);
    const rejected = expect(b).rejects.toThrow();
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalledTimes(1));
    control.revoke("Take back");
    expect(control.state()).toMatchObject({ owner: "human", releasing: true });
    expect(() => control.grant()).toThrow(/busy/);
    await expect(control.run(old)).rejects.toThrow();
    pending.resolve({ text: "already dispatched capture" }); await a; await rejected;
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(control.state().releasing).toBe(false);
    control.grant(); await expect(control.run(old)).rejects.toThrow(/stale/);
  });
  it("fails closed before approval if the original target cannot be described", async () => {
    const approval = vi.fn(async () => true);
    const { adapter, control, request } = setup(approval);
    vi.mocked(adapter.describeTarget).mockRejectedValue(new Error("Stale DOM target"));
    await expect(control.run(request("click"))).rejects.toThrow(/Stale DOM/);
    expect(approval).not.toHaveBeenCalled(); expect(adapter.execute).not.toHaveBeenCalled();
    expect(control.state().owner).toBe("human");
  });
  it("cancels pending approval on take-back and revalidates after approval", async () => {
    const approval = deferred<boolean>(); const { control, adapter, request } = setup(() => approval.promise);
    const pending = control.run(request("click"));
    await vi.waitFor(() => expect(control.state().activity).toBe("click · desktop"));
    control.revoke("disconnected"); approval.resolve(true);
    await expect(pending).rejects.toThrow(); expect(adapter.execute).not.toHaveBeenCalled();
    control.grant(); vi.mocked(adapter.targets).mockResolvedValue([{ ...target, documentId: "new" }]);
    await expect(control.run(request())).rejects.toThrow(/Stale/);
  });
  it("does not execute an approval whose exact document changed while the user considered it", async () => {
    const approval = deferred<boolean>(); const { control, adapter, request } = setup(() => approval.promise);
    const pending = control.run(request("click"));
    await vi.waitFor(() => expect(control.state().activity).toBe("click · desktop"));
    vi.mocked(adapter.targets).mockResolvedValue([{ ...target, documentId: "new-document" }]);
    approval.resolve(true);
    await expect(pending).rejects.toThrow(/Stale/);
    expect(adapter.execute).not.toHaveBeenCalled(); expect(control.state().owner).toBe("human");
  });
  it("bounds verification calls and never resets spend on a new handoff", async () => {
    const { control, request } = setup();

    for (let n = 0; n < 24; n++) await control.run(request());
    control.revoke("done"); control.grant();
    await expect(control.run(request())).rejects.toThrow(/budget/);
    expect(control.state().owner).toBe("human");
    control.resetBudget(); expect(control.state().remaining).toBe(24);
  });
  it("rejects evaluation, extra authority flags, oversize and forged page permission messages", () => {
    const { request } = setup();

    for (const value of [{ ...request(), operation: "evaluate" }, { ...request(), approved: true }, { ...request(), resolvedTarget: actionTarget }, { ...request(), operation: "describe-target" }, { ...request(), text: "x".repeat(4097) }, { ...request(), x: Infinity }]) expect(() => assertBrowserRequest(value)).toThrow();
    const forged = { protocol: "mauxi-preview-v1", session: "session", generation: "gen", kind: "grant", owner: "agent" };
    expect(isBridgeMessage(forged)).toBe(false); expect(isShellMessage(forged)).toBe(false);
  });
});
