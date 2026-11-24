import { useRef, type KeyboardEvent } from "react";
import { sweepWidths, type AuditFinding } from "../application/audit-contract";

const MIN = 320;
const MAX = 1920;
const MAJORS = [320, 480, 768, 1024, 1280, 1920];

/** Where a width sits on the scope, 0 to 1. Log scale: the phone widths, where most failures live, get room. */
export function scopePosition(width: number): number {
  return Math.log(Math.min(MAX, Math.max(MIN, width)) / MIN) / Math.log(MAX / MIN);
}

const covers = (finding: AuditFinding, width: number) => finding.ranges.some(([from, to]) => from <= width && width <= to);

/**
 * The width scope: a neutral ruler of the 320 to 1920 px sweep in the top bar. One mark per measured width, as tall as
 * the number of findings measured there, in neutral ink; only the finding being looked at (lit) shows its ranges in its
 * severity colour. It is also a slider: dragging along it or using the arrow keys resizes a live preview to a measured
 * width (onScrub). value: the width it shows as chosen; active: false before any audit, when it only explains itself.
 */
export function WidthScope({ findings, lit, value, locked, active, onScrub }: {
  findings: AuditFinding[]; lit: AuditFinding | null; value: number; locked: boolean; active: boolean; onScrub: (width: number, phase: "start" | "move" | "end") => void;
}) {
  const widths = sweepWidths();
  const plot = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const counts = widths.map((width) => findings.filter((finding) => covers(finding, width)).length);
  const peak = Math.max(1, ...counts);
  const clamp = (index: number) => Math.max(0, Math.min(widths.length - 1, index));
  const index = clamp(widths.findIndex((width) => width >= value) === -1 ? widths.length - 1 : widths.findIndex((width) => width >= value));
  const here = findings.filter((finding) => covers(finding, value)).length;
  const preview = value <= 1024 ? "Mobile" : "Desktop";

  /** The measured width nearest the pointer, on the log scale the scope is drawn in. */
  const under = (clientX: number) => {
    const rect = plot.current!.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    return widths.reduce((best, width) => Math.abs(scopePosition(width) - at) < Math.abs(scopePosition(best) - at) ? width : best, widths[0]);
  };

  const move = (clientX: number, phase: "start" | "move" | "end") => {
    const width = under(clientX);

    if (phase === "move" && width === drag.current) return;
    drag.current = phase === "end" ? null : width;
    onScrub(width, phase);
  };

  /** The measured width a key moves to: the previous or next one, five at a time with Page keys, or either end. */
  const stepTo = (key: string): number | null => {
    switch (key) {
      case "ArrowLeft": case "ArrowDown": return widths.findLast((width) => width < value) ?? widths[0];
      case "ArrowRight": case "ArrowUp": return widths.find((width) => width > value) ?? widths.at(-1)!;
      case "PageDown": return widths[clamp(index - 5)];
      case "PageUp": return widths[clamp(index + 5)];
      case "Home": return widths[0];
      case "End": return widths.at(-1)!;
      default: return null;
    }
  };

  const keydown = (event: KeyboardEvent) => {
    const width = stepTo(event.key);

    if (width === null) return;
    event.preventDefault();
    onScrub(width, "end");
  };

  if (!active) return <div className="width-scope" data-inert="" aria-hidden="true"><span className="scope-empty">Run an audit to measure widths</span></div>;

  return <div className="width-scope" data-spotlight={lit ? "" : undefined} role="slider" tabIndex={0} aria-label="Resize a live preview to a measured width"
    aria-valuemin={widths[0]} aria-valuemax={widths.at(-1)} aria-valuenow={value}
    aria-valuetext={`${value} px, ${preview} preview, ${here} ${here === 1 ? "finding" : "findings"} here`} aria-disabled={locked || undefined}
    title="Drag to resize the Mobile (up to 1024 px) or Desktop preview to a measured width"
    onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); move(event.clientX, "start"); }}
    onPointerMove={(event) => { if (drag.current !== null) move(event.clientX, "move"); }}
    onPointerUp={(event) => { if (drag.current !== null) move(event.clientX, "end"); }}
    onPointerCancel={() => { if (drag.current !== null) { onScrub(drag.current, "end"); drag.current = null; } }}
    onKeyDown={keydown}>
    <div className="scope-readout" aria-hidden="true"><strong>{value}<small>px</small></strong><span>{preview} · {here} {here === 1 ? "finding" : "findings"}</span></div>
    <div className="scope-track">
    <div className="scope-plot" ref={plot} aria-hidden="true">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
        {widths.map((width, at) => {
          const height = 8 + counts[at] / peak * 92;

          return <rect key={width} className="scope-bar" data-width={width} data-count={counts[at]} data-lit={lit && covers(lit, width) || undefined}
            x={scopePosition(width) * 1000 - 2} width={4} y={100 - height} height={height} />;
        })}
      </svg>
      <span className="scope-axis" />
      {lit?.ranges.map(([from, to]) => <span key={`${from}-${to}`} className="scope-span" data-severity={lit.severity}
        style={{ left: `${scopePosition(from) * 100}%`, width: `max(3px, ${(scopePosition(to) - scopePosition(from)) * 100}%)` }} />)}
      <span className="scope-cursor" style={{ left: `${scopePosition(value) * 100}%` }} />
    </div>
    <div className="scope-ticks" aria-hidden="true">
      {MAJORS.map((width, at) => <span key={width} data-edge={at === 0 ? "first" : at === MAJORS.length - 1 ? "last" : undefined} style={{ left: `${scopePosition(width) * 100}%` }}>{width}</span>)}
    </div>
    </div>
  </div>;
}
