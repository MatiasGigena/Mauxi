import { useEffect, useMemo, useState } from "react";
import type { LaunchPlan, ProjectDiscovery, WorkspaceBootstrap } from "../application/project-contract";
import { Workspace } from "./Workspace";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PlanDetails({ plan }: { plan: LaunchPlan }) {
  return (
    <div className="plan-details">
      <dl>
        <div><dt>App root</dt><dd title={plan.appRoot}>{plan.appRoot}</dd></div>
        <div><dt>Framework</dt><dd>{plan.framework === "vite" ? "React + Vite" : "Next.js"}</dd></div>
        <div><dt>Package manager</dt><dd>{plan.packageManager}</dd></div>
        <div><dt>Dev command</dt><dd><code>{plan.commandDisplay}</code></dd></div>
        <div><dt>Preview origin</dt><dd><code>{plan.origin}</code></dd></div>
      </dl>
      <section className="integration-preview">
        <div><strong>Temporary integration</strong><span>{plan.integration.summary}</span></div>
        {plan.integration.files.map((file) => (
          <details key={`${file.action}:${file.path}`}>
            <summary><span className={`change-kind ${file.action}`}>{file.action}</span><code>{file.path}</code></summary>
            <pre>{file.diff}</pre>
          </details>
        ))}
      </section>
      {plan.diagnostics.map((item) => <p className={`diagnostic ${item.level}`} key={item.code}>{item.message}</p>)}
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!window.mauxi) {
      setBootstrap({ mode: "proof", active: null, recoveryConflicts: [] });
      return;
    }
    void window.mauxi.getBootstrap().then(setBootstrap).catch((reason) => setError(errorMessage(reason)));
    return window.mauxi.onWorkspaceEvent((event) => {
      setBootstrap((current) => ({ mode: current?.mode ?? "project", ...event }));
    });
  }, []);

  const selectedPlan = useMemo(() => discovery?.plans.find((plan) => plan.id === selectedPlanId) ?? null, [discovery, selectedPlanId]);

  async function openProject() {
    if (!window.mauxi) return;
    setBusy(true); setError("");
    try {
      const result = await window.mauxi.openProject();
      if (!result) return;
      setDiscovery(result);
      setSelectedPlanId(result.rememberedPlanId ?? result.plans[0]?.id ?? "");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function confirm(mode: "start" | "attach") {
    if (!window.mauxi || !discovery || !selectedPlan) return;
    setBusy(true); setError("");
    try {
      await window.mauxi.confirmProject({ discoveryId: discovery.discoveryId, planId: selectedPlan.id, mode });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function closeProject() {
    if (!window.mauxi) return;
    setBusy(true); setError("");
    try {
      await window.mauxi.closeProject();
      setDiscovery(null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  if (!bootstrap && !error) return <div className="launch-screen"><div className="launch-card"><span className="brand-mark large">M</span><p>Checking recovery records…</p></div></div>;
  if (bootstrap?.mode === "proof") return <Workspace />;
  if (bootstrap?.active) return (
    <>
      <Workspace active={bootstrap.active} onClose={() => void closeProject()} />
      {error && <div className="floating-error" role="alert">{error}</div>}
    </>
  );

  return (
    <main className="launch-screen">
      <header className="launch-brand"><span className="brand-mark large">M</span><div><h1>Mauxi</h1><p>Open a local interface project</p></div></header>
      <section className="launch-card" aria-busy={busy}>
        {bootstrap?.recoveryConflicts.length ? (
          <div className="recovery-warning" role="alert"><strong>Recovery needs attention</strong>{bootstrap.recoveryConflicts.map((item) => <p key={item}>{item}</p>)}</div>
        ) : null}
        {!discovery ? (
          <div className="empty-launch">
            <div className="folder-art" aria-hidden="true">⌁</div>
            <h2>Choose an existing project</h2>
            <p>Mauxi reads manifests and lockfiles first. It will not execute configuration, install dependencies, or launch a server until you confirm the plan.</p>
            <button className="primary" disabled={busy} onClick={() => void openProject()}>{busy ? "Opening…" : "Open project…"}</button>
          </div>
        ) : (
          <div className="confirmation">
            <div className="confirmation-heading">
              <div><span className="eyebrow">CONFIRM PROJECT SETUP</span><h2>{discovery.canonicalRoot.split(/[\\/]/).pop()}</h2><p title={discovery.canonicalRoot}>{discovery.canonicalRoot}</p></div>
              <button disabled={busy} onClick={() => void openProject()}>Choose another…</button>
            </div>
            <div className="project-facts">
              <span>{discovery.git.repository ? (discovery.git.dirty ? "Git · local changes preserved" : "Git · clean working tree") : "Not a Git repository"}</span>
              <span>{discovery.plans.length} launch {discovery.plans.length === 1 ? "plan" : "plans"}</span>
            </div>
            {discovery.diagnostics.map((item) => <p className={`diagnostic ${item.level}`} key={item.code}>{item.message}</p>)}
            {discovery.plans.length > 1 && (
              <label className="plan-picker"><span>Application and script</span><select value={selectedPlanId} onChange={(event) => setSelectedPlanId(event.target.value)}>{discovery.plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.label}</option>)}</select></label>
            )}
            {selectedPlan && <PlanDetails plan={selectedPlan} />}
            <div className="confirmation-actions">
              <div><strong>No automatic installs</strong><span>Temporary hooks are journaled before the first file change.</span></div>
              <button disabled={busy || !selectedPlan || selectedPlan.diagnostics.some((item) => item.level === "error")} onClick={() => void confirm("attach")}>Attach to existing</button>
              <button className="primary" disabled={busy || !selectedPlan || selectedPlan.diagnostics.some((item) => item.level === "error")} onClick={() => void confirm("start")}>{busy ? "Preparing…" : "Confirm & start"}</button>
            </div>
          </div>
        )}
        {error && <p className="diagnostic error" role="alert">{error}</p>}
      </section>
      <p className="launch-footnote">One active project · Linux private alpha · AppImage</p>
    </main>
  );
}
