import type { ElementFingerprint, SelectionCapture } from "./preview-contract";

export type SelectionStatus = "current" | "stale";

export interface StoredSelection {
  capture: SelectionCapture;
  status: SelectionStatus;
  staleReason?: string;
  requiresRepick?: boolean;
}

export function fingerprintsMatch(original: ElementFingerprint, current: ElementFingerprint): boolean {
  if (original.tag !== current.tag) return false;
  if (original.sourceKey && current.sourceKey && original.sourceKey !== current.sourceKey) return false;
  if (original.testId && current.testId) return original.testId === current.testId && original.text === current.text;
  return original.selector === current.selector && original.text === current.text;
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
      ? { ...selection, status: "stale", staleReason: "The preview document changed; revalidate or pick again." }
      : selection,
  );
}
