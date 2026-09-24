import { Fragment, useId, useRef, useState, type MouseEvent } from "react";
import { ChevronDown } from "lucide-react";
import type { IntegrationPreview } from "../application/project-contract";
import type { useDisclosureMotion } from "./useDisclosureMotion";

export function DiffLines({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return <pre className="guided-diff"><code>{lines.map((line, index) => {
    const kind = line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : "context";
    return <span key={index} className={`diff-line ${kind}`}>{line}{index < lines.length - 1 ? "\n" : ""}</span>;
  })}</code></pre>;
}

export function IntegrationChanges({ files, motion }: { files: IntegrationPreview["files"]; motion: ReturnType<typeof useDisclosureMotion> }) {
  const [selected, setSelected] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  function change(next: number | null, keyboard = false) {
    const screen = root.current!.closest(".launch-screen")!;
    if (next === null && selected !== null) {
      root.current!.querySelector<HTMLButtonElement>(`[data-file-index="${selected}"]`)?.focus({ preventScroll: true });
    }
    motion.change({
      moving: [...screen.querySelectorAll<HTMLElement>(".launch-brand, .guided-intro, .guided-integration, .project-setup .confirmation-actions")],
      layers: [...root.current!.querySelectorAll<HTMLElement>("[data-file-layer]")],
      update: () => setSelected(next), opening: next !== null, keyboard,
    });
  }
  function toggle(index: number, event: MouseEvent<HTMLButtonElement>) { change(selected === index ? null : index, event.detail === 0); }

  return <div ref={root} className="guided-file-list" data-selected={selected ?? "none"} onKeyDown={event => {
    if (event.key === "Escape" && selected !== null) { event.preventDefault(); event.stopPropagation(); change(null, true); }
  }}>
    {files.length === 0 && <p className="empty-integration">No files need to be changed.</p>}
    {files.map((file, index) => {
      const expanded = selected === index;
      const hidden = selected !== null && !expanded;
      const triggerId = `${id}-trigger-${index}`;
      const panelId = `${id}-diff-${index}`;
      return <Fragment key={`${file.action}:${file.path}`}>
        <button id={triggerId} className="guided-file-trigger" data-action={file.action} data-file-index={index} data-file-layer aria-hidden={hidden} inert={hidden} aria-expanded={expanded} aria-controls={panelId} onClick={event => toggle(index, event)}>
          <code>{file.path}</code><ChevronDown size={14} aria-hidden="true" />
        </button>
        <section id={panelId} className="guided-file-panel" role="region" aria-labelledby={triggerId} data-file-layer aria-hidden={!expanded} inert={!expanded}>
          <DiffLines diff={file.diff} />
        </section>
      </Fragment>;
    })}
  </div>;
}
