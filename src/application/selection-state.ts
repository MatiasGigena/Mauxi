import type { ElementFingerprint, SelectionCapture } from "./preview-contract";

export type SelectionStatus = "current" | "stale";

export interface StoredSelection {
  capture: SelectionCapture;
  status: SelectionStatus;
  interaction?: "pointer" | "keyboard";
  staleReason?: string;
  requiresRepick?: boolean;
}

/** Mark only live draft attachments in their original preview document. */
export function selectionMarkerIds(selections: readonly StoredSelection[], previewId: string, generation: string): string[] {
  return selections.filter(item => item.status === "current" && !item.requiresRepick
    && item.capture.previewId === previewId && item.capture.documentGeneration === generation)
    .slice(0, 8).map(item => item.capture.selectionId);
}

export function selectionCapturePaths(selections: readonly StoredSelection[]): string[] {
  return [...new Set(selections.flatMap(({ capture }) => capture.screenshot.status === "captured" && capture.screenshot.path ? [capture.screenshot.path] : []))];
}

export function fingerprintsMatch(original: ElementFingerprint, current: ElementFingerprint): boolean {
  if (original.instanceKey !== current.instanceKey || original.tag !== current.tag) return false;
  if (original.sourceKey !== current.sourceKey) return false;
  if (original.testId || current.testId) return original.testId === current.testId && original.text === current.text;
  // A selector is supporting evidence, not permanent identity. The instance key
  // permits an unambiguously retained node to move when a list is reordered.
  return original.text === current.text;
}

export function markSelectionsAfterRouteChange(
  selections: StoredSelection[],
  previewId: string,
): StoredSelection[] {
  return selections.map((selection) => selection.capture.previewId === previewId
    ? { ...selection, status: "stale", requiresRepick: true, staleReason: "The preview route changed; pick this target again." }
    : selection);
}

export function markSelectionsAfterDocumentChange(
  selections: StoredSelection[],
  previewId: string,
  newGeneration: string,
): StoredSelection[] {
  return selections.map((selection) =>
    selection.capture.previewId === previewId && selection.capture.documentGeneration !== newGeneration
      ? { ...selection, status: "stale", requiresRepick: true, staleReason: "The preview document changed; pick this target again." }
      : selection,
  );
}
