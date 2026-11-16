import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Moon, Sun } from "lucide-react";
import type { ProjectDiscovery, WorkspaceBootstrap } from "../application/project-contract";
import { Workspace } from "./Workspace";
import { ProjectSetup } from "./ProjectSetup";
import logoTextDark from "./assets/logo-mauxi-text.png";
import logoTextLight from "./assets/logo-mauxi-text-light.png";
import { setTheme, useTheme } from "./theme";
import { errorText } from "./error-text";

export function App() {
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap | null>(null);
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const theme = useTheme();
  const logoText = theme === "dark" ? logoTextLight : logoTextDark;

  useEffect(() => {
    if (!window.mauxi) {
      setBootstrap({ mode: "proof", active: null, recoveryConflicts: [] });

      return;
    }

    void window.mauxi.getBootstrap().then(setBootstrap).catch((reason) => setError(errorText(reason)));

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
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!window.mauxi || !discovery || !selectedPlan) return;
    setBusy(true); setError("");

    try {
      const active = await window.mauxi.confirmProject({ discoveryId: discovery.discoveryId, planId: selectedPlan.id, mode: "start", startPath: "/" });
      setBootstrap((current) => ({ mode: current?.mode ?? "project", active, recoveryConflicts: current?.recoveryConflicts ?? [] }));
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }

  if (!bootstrap && !error) return <main className="launch-screen is-empty"><img className="launch-logo" src={logoText} alt="Mauxi" /><p>Checking recovery records…</p></main>;

  if (bootstrap?.mode === "proof") return <Workspace />;

  if (bootstrap?.active) return (
    <>
      <Workspace active={bootstrap.active} onClose={async () => { if (!window.mauxi) return; const result = await window.mauxi.closeProject(); setDiscovery(null); setBusy(false); setError(""); setBootstrap(current => ({ mode: current?.mode ?? "project", ...result })); }} />
      {error && <div className="floating-error" role="alert">{error}</div>}
    </>
  );

  return (
    <main className={`launch-screen${discovery ? " has-setup" : " is-empty"}`}>
      <button type="button" className="theme-toggle" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Light mode" : "Dark mode"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      </button>
      {discovery ? (
        <h1 className="launch-brand setup-brand"><img className="launch-logo" src={logoText} alt="Mauxi" /></h1>
      ) : (
        <h1 className="launch-brand"><img className="launch-logo" src={logoText} alt="Mauxi" /></h1>
      )}
      <section className={discovery ? "launch-setup" : "launch-entry"} aria-busy={busy}>
        {bootstrap?.recoveryConflicts.length ? (
          <div className="recovery-warning" role="alert"><strong>Recovery needs attention</strong>{bootstrap.recoveryConflicts.map((item) => <p key={item}>{item}</p>)}</div>
        ) : null}
        {!discovery ? (
          <button className="primary" disabled={busy} onClick={() => void openProject()}><FolderOpen size={17} aria-hidden="true" /><span>{busy ? "Opening Project" : "Open Project"}</span></button>
        ) : (
          <ProjectSetup key={discovery.discoveryId} discovery={discovery} plan={selectedPlan} busy={busy} onSelectPlan={setSelectedPlanId} onChooseProject={() => void openProject()} onConfirm={() => void confirm()} />
        )}
        {error && <p className="diagnostic error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
