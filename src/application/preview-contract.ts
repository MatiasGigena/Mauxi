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

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

function finiteRecord(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]));
}

function nullableString(value: unknown, limit: number): boolean {
  return value === null || boundedString(value, limit);
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function boundedStringRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, item]) => key.length <= 128 && boundedString(item, 2_048));
}

export function isBridgeMessage(value: unknown): value is BridgeToShellMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.protocol !== BRIDGE_PROTOCOL || typeof record.kind !== "string") return false;
  if (!boundedString(record.session, 128) || !boundedString(record.generation, 128)) return false;
  if (record.kind === "ready") {
    return boundedString(record.url, 4_096)
      && finiteRecord(record.viewport, ["width", "height"])
      && typeof record.reactGrab === "boolean";
  }
  if (record.kind === "revalidation") {
    return boundedString(record.selectionId, 128)
      && (record.status === "valid" || record.status === "stale")
      && (record.reason === undefined || boundedString(record.reason, 1_024));
  }
  if (record.kind !== "selection" || !record.capture || typeof record.capture !== "object") return false;
  const capture = record.capture as Record<string, unknown>;
  const element = capture.element as Record<string, unknown> | undefined;
  const source = capture.source as Record<string, unknown> | undefined;
  const fingerprint = capture.fingerprint as Record<string, unknown> | undefined;
  return boundedString(capture.selectionId, 128)
    && boundedString(capture.documentGeneration, 128)
    && boundedString(capture.capturedAt, 64)
    && boundedString(capture.url, 4_096)
    && finiteRecord(capture.viewport, ["width", "height", "deviceScaleFactor"])
    && finiteRecord(capture.coordinates, ["clientX", "clientY"])
    && (capture.coordinates as Record<string, unknown>).space === "preview-css-pixels"
    && finiteRecord(capture.bounds, ["x", "y", "width", "height"])
    && !!element
    && boundedString(element.tag, 64)
    && boundedString(element.label, 1_024)
    && nullableString(element.role, 128)
    && boundedString(element.html, 16_384)
    && !!source
    && boundedString(source.filePath, 1_024)
    && nullableNumber(source.lineNumber)
    && nullableNumber(source.columnNumber)
    && nullableString(source.componentName, 256)
    && (source.method === "react-grab" || source.method === "jsx-attribute" || source.method === "unresolved")
    && nullableString(source.fileFingerprint, 128)
    && !!fingerprint
    && nullableString(fingerprint.selector, 2_048)
    && boundedString(fingerprint.tag, 64)
    && nullableString(fingerprint.testId, 512)
    && boundedString(fingerprint.text, 4_096)
    && nullableString(fingerprint.sourceKey, 1_024)
    && boundedStringRecord(capture.computedStyles);
}
