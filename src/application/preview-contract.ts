export const BRIDGE_PROTOCOL = "mauxi-preview-v1" as const;

export type PreviewId = "desktop" | "mobile";

export interface SourceLocation {
  filePath: string;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
  method: "react-grab" | "jsx-attribute" | "unresolved";
  fileFingerprint: string | null;
}

export interface ElementFingerprint {
  selector: string | null;
  tag: string;
  testId: string | null;
  text: string;
  sourceKey: string | null;
}

export interface SelectionCapture {
  selectionId: string;
  previewId: PreviewId;
  documentGeneration: string;
  capturedAt: string;
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  coordinates: { clientX: number; clientY: number; space: "preview-css-pixels" };
  element: { tag: string; label: string; role: string | null; html: string };
  bounds: { x: number; y: number; width: number; height: number };
  source: SourceLocation;
  fingerprint: ElementFingerprint;
  computedStyles: Record<string, string>;
}

export type BridgeToShellMessage =
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "ready"; session: string; generation: string; url: string; viewport: { width: number; height: number }; reactGrab: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection"; session: string; generation: string; capture: Omit<SelectionCapture, "previewId"> }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "revalidation"; session: string; generation: string; selectionId: string; status: "valid" | "stale"; reason?: string };

export type ShellToBridgeMessage =
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection-mode"; session: string; generation: string; enabled: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "revalidate"; session: string; generation: string; selectionId: string; fingerprint: ElementFingerprint };

export function isBridgeMessage(value: unknown): value is BridgeToShellMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.protocol !== BRIDGE_PROTOCOL || typeof record.kind !== "string") return false;
  if (typeof record.session !== "string" || record.session.length > 128) return false;
  if (typeof record.generation !== "string" || record.generation.length > 128) return false;
  return ["ready", "selection", "revalidation"].includes(record.kind);
}
