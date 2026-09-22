import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { BrowserState } from "../application/browser-contract";

export function useBrowserControl(workspaceId?: string) {
  const [state, setState] = useState<BrowserState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef<BrowserState | undefined>(undefined);
  const update = (value: BrowserState) => {
    if (value.workspaceId !== workspaceId || (latest.current && value.generation < latest.current.generation)) return;
    latest.current = value; setState(value);
  };
  useEffect(() => {
    if (!workspaceId || !window.mauxi) return;
    const api = window.mauxi;
    const off = api.onBrowserState(update);
    void api.browserState().then(update).catch(e => setError(String(e)));
    const heartbeat = setInterval(() => { void api.browserHeartbeat(workspaceId).catch(() => setError("Preview host disconnected")); }, 1000);
    return () => { off(); clearInterval(heartbeat); void api.browserOwner({ workspaceId, owner: "human" }).catch(() => undefined); };
  }, [workspaceId]);
  const owner = async (next: "human" | "picker" | "agent") => {
    if (!workspaceId || !window.mauxi) return;
    setError("");
    if (next === "agent") flushSync(() => setPending(true));
    try { update(await window.mauxi.browserOwner({ workspaceId, owner: next })); }
    catch (e) { setError(String(e)); }
    finally { setPending(false); }
  };
  return { state, error, pending, locked: pending || state?.owner === "agent" || !!state?.releasing, owner };
}

export function BrowserControlBar({ control, ready, onGrant }: {
  control: ReturnType<typeof useBrowserControl>; ready: boolean; onGrant: () => void;
}) {
  const { state, error, locked } = control;
  return <div className="browser-control" aria-label="Preview control">
    <span role="status" title={error || state?.activity}>{error || (control.pending ? "Handing over…" : state?.releasing ? "Returning control…" : locked ? state?.activity : state?.owner === "picker" ? "Picker control" : "Your control")}</span>
    {locked ? <button className="take-back" onClick={() => void control.owner("human")}>Take back control</button>
      : <button disabled={!ready || !state} onClick={onGrant} title="Allow bounded checks in both visible previews. Use test accounts; every interaction requires separate approval.">Give agent control</button>}
    {!!state?.evidence.length && <details className="browser-evidence"><summary>Checks · {state.evidence.length}</summary><div className="browser-evidence-popover">
      <strong>Recorded checks, not model claims</strong>
      <p>Actions dispatched are not proof of a successful result. Offscreen content and unrecorded behavior remain unverified.</p>
      {(["desktop", "mobile"] as const).map(id => <section key={id}><h3>{id === "desktop" ? "Desktop" : "Mobile"}</h3>
        {!state.evidence.some(e => e.previewId === id) && <p>Not checked this run.</p>}
        {state.evidence.filter(e => e.previewId === id).map(e => <article key={e.id}><strong>{e.operation}</strong><time>{new Date(e.at).toLocaleTimeString()}</time><pre>{e.summary}</pre>{e.image && <img alt={`Actual ${id} preview capture`} src={`data:image/png;base64,${e.image}`} />}</article>)}
      </section>)}
    </div></details>}
  </div>;
}
