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
