import { useCallback, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, ArrowUpRight, ChevronDown, Plug, Settings2 } from "lucide-react";
import type { LaunchPlan, ProjectDiscovery } from "../application/project-contract";
import { IntegrationChanges } from "./IntegrationChanges";
import { ScriptSelect } from "./ScriptSelect";
import { useDisclosureMotion } from "./useDisclosureMotion";

interface ProjectSetupProps {
  discovery: ProjectDiscovery;
  plan: LaunchPlan | null;
  busy: boolean;
  onSelectPlan: (id: string) => void;
  onChooseProject: () => void;
  onConfirm: () => void;
}

type View = "overview" | "configure" | "review";

export function integrationSummary(plan: LaunchPlan): string {
  if (!plan.integration.supported) return "Integration unavailable for this setup.";
  const modified = plan.integration.files.filter(file => file.action === "modify").length;
  const created = plan.integration.files.filter(file => file.action === "create").length;
  const parts = [];

  if (modified) parts.push(`${modified} ${modified === 1 ? "file" : "files"} modified`);

  if (created) parts.push(`${created} ${created === 1 ? "artifact" : "artifacts"} created`);

  return parts.length ? `${parts.join(", ")}. Temporary changes cleaned up on close.` : "No file changes required.";
}

export function ProjectSetup({ discovery, plan, busy, onSelectPlan, onChooseProject, onConfirm }: ProjectSetupProps) {
  const [view, setView] = useState<View>("overview");
  const [selectorState, setSelectorState] = useState({ open: false, keyboard: false });
  const onSelectorOpenChange = useCallback((open: boolean, keyboard: boolean) => setSelectorState({ open, keyboard }), []);
  const root = useRef<HTMLDivElement>(null);
  const configureTrigger = useRef<HTMLButtonElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const motion = useDisclosureMotion();
  const configId = useId();
  const reviewId = useId();
  const configuring = view === "configure";
  const reviewing = view === "review";
  const appRoot = plan?.appRoot ?? discovery.canonicalRoot;
  const separator = plan?.label.lastIndexOf(" — ") ?? -1;
  const name = plan && separator > 0 ? plan.label.slice(0, separator) : appRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? appRoot;
  const diagnostics = [...discovery.diagnostics.filter(item => item.code !== "ambiguous-plan"), ...(plan?.diagnostics ?? [])];

  useLayoutEffect(() => {
    const screen = root.current!.closest(".launch-screen") ?? root.current!;
    motion.enter([...screen.querySelectorAll<HTMLElement>(".launch-brand, .guided-intro, .configure-trigger, .guided-integration, .confirmation-actions")]);

    return motion.cancel;
  }, []);

  function transition(next: View, keyboard = false) {
    const screen = root.current!.closest(".launch-screen")!;

    if (next === "overview") {
      const closingPanel = document.getElementById(configuring ? configId : reviewId);

      if (closingPanel?.contains(document.activeElement)) (configuring ? configureTrigger : reviewTrigger).current?.focus({ preventScroll: true });
    }

    motion.change({
      moving: [...screen.querySelectorAll<HTMLElement>(".launch-brand, .guided-intro, .project-setup .confirmation-actions")],
      layers: [...root.current!.querySelectorAll<HTMLElement>("[data-guided-layer]")],
      update: () => { setView(next); setSelectorState({ open: false, keyboard }); }, opening: next !== "overview", keyboard,
    });
  }

  function toggle(target: View, event: MouseEvent<HTMLButtonElement>) { transition(view === target ? "overview" : target, event.detail === 0); }

  return <div ref={root} className="project-setup" data-view={view} data-expanded={configuring} onKeyDown={event => {
    if (event.key === "Escape" && view !== "overview") {
      event.preventDefault(); event.stopPropagation();
      (configuring ? configureTrigger : reviewTrigger).current?.focus({ preventScroll: true });
      transition("overview", true);
    }
  }}>
    <div className="guided-intro"><h2>Let’s work on <span>{name}.</span></h2><p className="project-path">{appRoot}</p></div>
    {diagnostics.length > 0 && <div className="setup-diagnostics">{diagnostics.map((item, index) => <p className={`diagnostic ${item.level}`} role={item.level === "error" ? "alert" : undefined} key={`${item.code}:${index}`}>{item.message}</p>)}</div>}
    {plan && <div className="guided-rows">
      <button ref={configureTrigger} className="configure-trigger" data-guided-layer aria-hidden={reviewing} inert={reviewing} aria-expanded={configuring} aria-controls={configId} onClick={event => toggle("configure", event)}>
        <span className="row-icon"><Settings2 size={19} aria-hidden="true" /></span><span><strong>{plan.framework === "vite" ? "React + Vite" : "Next.js"}</strong><small>{plan.commandDisplay}</small></span>
        <span className="row-link"><span className="row-link-label">{configuring ? "Close configuration" : "Configure"}</span><ChevronDown size={15} aria-hidden="true" /></span>
      </button>
      <section id={configId} aria-label="Launch configuration" className="guided-inline-config" data-guided-layer aria-hidden={!configuring} inert={!configuring}>
        <ScriptSelect plans={discovery.plans} value={plan.id} disabled={busy || discovery.plans.length < 2}
          open={selectorState.open && configuring} keyboard={selectorState.keyboard} onOpenChange={onSelectorOpenChange}
          onChange={id => { motion.cancel(); onSelectPlan(id); }} />
        <dl className="technical-details select-details" data-selector-open={selectorState.open} data-selector-keyboard={selectorState.keyboard} aria-hidden={selectorState.open} inert={selectorState.open}>
          <div><dt>App root</dt><dd>{plan.appRoot}</dd></div>
          <div><dt>Framework</dt><dd>{plan.framework === "vite" ? "React + Vite" : "Next.js"}</dd></div>
          <div><dt>Package manager</dt><dd>{plan.packageManager}</dd></div>
          <div><dt>Dev command</dt><dd><code>{plan.commandDisplay}</code></dd></div>
          <div><dt>Server origin</dt><dd><code>{plan.origin}</code></dd></div>
        </dl>
      </section>
      <div className="guided-integration" data-guided-layer aria-hidden={configuring} inert={configuring}>
        <button ref={reviewTrigger} className="review-trigger" aria-expanded={reviewing} aria-controls={reviewId} onClick={event => toggle("review", event)}>
          <span className="row-icon"><Plug size={19} aria-hidden="true" /></span><span><strong>Temporary integration</strong><small title={plan.integration.summary}>{integrationSummary(plan)}</small></span><span className="row-link"><span className="row-link-label">{reviewing ? "Close review" : "Review"}</span><ArrowUpRight size={15} aria-hidden="true" /></span>
        </button>
      </div>
      <section id={reviewId} aria-label="Temporary integrations" className="guided-inline-review" data-guided-layer aria-hidden={!reviewing} inert={!reviewing}>
        <IntegrationChanges key={plan.id} files={plan.integration.files} motion={motion} />
      </section>
    </div>}
    <div className="confirmation-actions">
      <button className="change-project has-hover-copy" disabled={busy} onClick={onChooseProject} aria-label="Not this project? Choose another">
        <span className="change-project-copy" aria-hidden="true"><span className="change-project-idle">Not this project?</span><span className="change-project-intent">Choose another</span></span>
      </button>
      <button className="primary" disabled={busy || !plan || !plan.integration.supported || plan.diagnostics.some(item => item.level === "error")} onClick={onConfirm}>
        <span>{busy ? "Preparing…" : "Confirm & start"}</span><ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
