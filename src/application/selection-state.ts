import selection, { type BendList, type BendSel } from "./generated/selection.mjs";
import type { ElementFingerprint, SelectionCapture } from "./preview-contract";

export type SelectionStatus = "current" | "stale";

export interface StoredSelection {
  capture: SelectionCapture;
  status: SelectionStatus;
  interaction?: "pointer" | "keyboard";
  staleReason?: string;
  requiresRepick?: boolean;
}

// Freshness decisions live in bend/selection.bend, where LAWS.bend proves them;
// each returns one flag per stored selection, in order.
function toBend(selections: readonly StoredSelection[]): BendList<BendSel> {
  return selections.reduceRight<BendList<BendSel>>((tail, { capture, status, requiresRepick }) => ({
    $: "Con",
    head: { $: "Sel", preview: capture.previewId, generation: capture.documentGeneration, current: status === "current", repick: requiresRepick === true },
    tail,
  }), { $: "Nil" });
}

function flags(list: BendList<boolean>): boolean[] {
  const result: boolean[] = [];

  for (let node = list; node.$ === "Con"; node = node.tail) result.push(node.head);

  return result;
}

export function selectionMarkerIds(selections: readonly StoredSelection[], previewId: string, generation: string): string[] {
  const marked = flags(selection["Selection.markers"](toBend(selections), 8, previewId, generation));

  return selections.flatMap((item, index) => marked[index] ? [item.capture.selectionId] : []);
}

export function selectionCapturePaths(selections: readonly StoredSelection[]): string[] {
  return [...new Set(selections.flatMap(({ capture }) => capture.screenshot.status === "captured" && capture.screenshot.path ? [capture.screenshot.path] : []))];
}

export function fingerprintsMatch(original: ElementFingerprint, current: ElementFingerprint): boolean {
  if (original.instanceKey !== current.instanceKey || original.tag !== current.tag) return false;

  if (original.sourceKey !== current.sourceKey) return false;

  if (original.testId || current.testId) return original.testId === current.testId && original.text === current.text;

  return original.text === current.text;
}

export function markSelectionsAfterRouteChange(
  selections: StoredSelection[],
  previewId: string,
): StoredSelection[] {
  const stale = flags(selection["Selection.stale_after_route"](toBend(selections), previewId));

  return selections.map((item, index) => stale[index]
    ? { ...item, status: "stale", requiresRepick: true, staleReason: "The preview route changed; pick this target again." }
    : item);
}

export function markSelectionsAfterDocumentChange(
  selections: StoredSelection[],
  previewId: string,
  newGeneration: string,
): StoredSelection[] {
  const stale = flags(selection["Selection.stale_after_document"](toBend(selections), previewId, newGeneration));

  return selections.map((item, index) => stale[index]
    ? { ...item, status: "stale", requiresRepick: true, staleReason: "The preview document changed; pick this target again." }
    : item);
}
