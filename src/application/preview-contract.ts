export const BRIDGE_PROTOCOL = "mauxi-preview-v1" as const;

export type PreviewId = "desktop" | "mobile";

export type SourceVerification = "unverified" | "verified" | "missing-or-ambiguous" | "library";

export type SourceRole = "jsx-element" | "component-owner" | "caller" | "unknown";

export interface SourceLocation {
  filePath: string;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
  method: "react-grab" | "jsx-attribute" | "unresolved";
  fileFingerprint: string | null;
  role: SourceRole;
  ownership: "application" | "library" | "unknown";
  verification: SourceVerification;
}

export interface DomAncestryEntry {
  tag: string;
  label: string;
  selector: string | null;
  testId: string | null;
  selected: boolean;
}

export interface ComponentOwner {
  componentName: string;
  filePath: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  role: "component-owner" | "caller";
  ownership: "application" | "library" | "unknown";
}

export interface ElementFingerprint {
  selector: string | null;
  tag: string;
  testId: string | null;
  text: string;
  sourceKey: string | null;
  instanceKey: string;
}

export interface SelectionScreenshot {
  status: "pending" | "captured" | "unavailable";
  crop: { x: number; y: number; width: number; height: number; space: "preview-css-pixels" };
  path?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  reason?: string;
}

export interface SelectionCapture {
  selectionId: string;
  workspaceId: string;
  previewId: PreviewId;
  documentGeneration: string;
  capturedAt: string;
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  coordinates: { clientX: number; clientY: number; space: "preview-css-pixels" };
  element: { tag: string; label: string; role: string | null; text: string; html: string };
  bounds: { x: number; y: number; width: number; height: number };
  source: SourceLocation;
  componentOwners: ComponentOwner[];
  domAncestry: DomAncestryEntry[];
  support: { status: "supported" | "unsupported"; reason: string | null };
  fingerprint: ElementFingerprint;
  computedStyles: Record<string, string>;
  screenshot: SelectionScreenshot;
}

export type BridgeToShellMessage =
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "canvas-shortcut"; session: string; generation: string; action: "exit" | "space" | "space-end" }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "canvas-zoom"; session: string; generation: string; deltaY: number; deltaMode: number; clientX: number; clientY: number }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection-cancelled" | "navigation-blocked"; session: string; generation: string }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "route"; session: string; generation: string; url: string; navigationId: string | null; safe: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "ready"; session: string; generation: string; url: string; viewport: { width: number; height: number }; reactGrab: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection"; session: string; generation: string; interaction?: "pointer" | "keyboard"; capture: Omit<SelectionCapture, "previewId" | "workspaceId"> }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "revalidation"; session: string; generation: string; selectionId: string; status: "valid" | "stale"; reason?: string };

export type ShellToBridgeMessage =
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "canvas-controls"; session: string; generation: string; enabled: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "connect"; session: string; generation: string }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "navigate"; session: string; generation: string; route: string; navigationId: string }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "reload"; session: string; generation: string }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection-mode"; session: string; generation: string; enabled: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "selection-markers"; session: string; generation: string; selectionIds: string[] }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "picker-visibility"; session: string; generation: string; hidden: boolean }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "picker-refine"; session: string; generation: string; action: "parent" | "child" | "overlap-next" | "overlap-previous" | "attach" }
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

function numberIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function boundedStringRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);

  return entries.length <= 64 && entries.every(([key, item]) => key.length <= 128 && boundedString(item, 2_048));
}

function validSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const value = source as Record<string, unknown>;

  return boundedString(value.filePath, 1_024)
    && (value.lineNumber === null || (numberIn(value.lineNumber, 1, 1_000_000) && Number.isInteger(value.lineNumber)))
    && (value.columnNumber === null || (numberIn(value.columnNumber, 0, 1_000_000) && Number.isInteger(value.columnNumber)))
    && nullableString(value.componentName, 256)
    && (value.method === "react-grab" || value.method === "jsx-attribute" || value.method === "unresolved")
    && nullableString(value.fileFingerprint, 128)
    && ["jsx-element", "component-owner", "caller", "unknown"].includes(String(value.role))
    && ["application", "library", "unknown"].includes(String(value.ownership))
    && ["unverified", "verified", "missing-or-ambiguous", "library"].includes(String(value.verification));
}

function validFingerprint(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;

  return nullableString(f.selector, 2_048) && boundedString(f.tag, 64) && nullableString(f.testId, 512)
    && boundedString(f.text, 4_096) && nullableString(f.sourceKey, 1_024) && boundedString(f.instanceKey, 128);
}

function validScreenshot(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const shot = value as Record<string, unknown>;
  const crop = shot.crop as Record<string, unknown> | undefined;

  return ["pending", "captured", "unavailable"].includes(String(shot.status))
    && finiteRecord(crop, ["x", "y", "width", "height"])
    && numberIn(crop?.x, -10_000, 20_000) && numberIn(crop?.y, -10_000, 20_000)
    && numberIn(crop?.width, 1, 10_000) && numberIn(crop?.height, 1, 10_000)
    && crop?.space === "preview-css-pixels"
    && (shot.path === undefined || boundedString(shot.path, 4_096))
    && (shot.width === undefined || (typeof shot.width === "number" && Number.isFinite(shot.width)))
    && (shot.height === undefined || (typeof shot.height === "number" && Number.isFinite(shot.height)))
    && (shot.capturedAt === undefined || boundedString(shot.capturedAt, 64))
    && (shot.reason === undefined || boundedString(shot.reason, 1_024));
}

export function isBridgeMessage(value: unknown): value is BridgeToShellMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  if (record.protocol !== BRIDGE_PROTOCOL || typeof record.kind !== "string") return false;

  if (!boundedString(record.session, 128) || !boundedString(record.generation, 128)) return false;

  if (record.kind === "canvas-shortcut") return record.action === "exit" || record.action === "space" || record.action === "space-end";

  if (record.kind === "canvas-zoom") return numberIn(record.deltaY, -100_000, 100_000)
    && typeof record.deltaMode === "number" && [0, 1, 2].includes(record.deltaMode)
    && numberIn(record.clientX, 0, 10_000) && numberIn(record.clientY, 0, 10_000);

  if (record.kind === "selection-cancelled" || record.kind === "navigation-blocked") return true;

  if (record.kind === "route") return boundedString(record.url, 4096) && nullableString(record.navigationId, 128) && typeof record.safe === "boolean";

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
  const support = capture.support as Record<string, unknown> | undefined;
  const ancestry = capture.domAncestry;
  const owners = capture.componentOwners;

  return (record.interaction === undefined || record.interaction === "pointer" || record.interaction === "keyboard")
    && boundedString(capture.selectionId, 128)
    && boundedString(capture.documentGeneration, 128)
    && boundedString(capture.capturedAt, 64)
    && boundedString(capture.url, 4_096)
    && finiteRecord(capture.viewport, ["width", "height", "deviceScaleFactor"])
    && numberIn((capture.viewport as Record<string, unknown>).width, 1, 10_000)
    && numberIn((capture.viewport as Record<string, unknown>).height, 1, 10_000)
    && numberIn((capture.viewport as Record<string, unknown>).deviceScaleFactor, .25, 8)
    && finiteRecord(capture.coordinates, ["clientX", "clientY"])
    && numberIn((capture.coordinates as Record<string, unknown>).clientX, -10_000, 20_000)
    && numberIn((capture.coordinates as Record<string, unknown>).clientY, -10_000, 20_000)
    && (capture.coordinates as Record<string, unknown>).space === "preview-css-pixels"
    && finiteRecord(capture.bounds, ["x", "y", "width", "height"])
    && numberIn((capture.bounds as Record<string, unknown>).x, -100_000, 100_000)
    && numberIn((capture.bounds as Record<string, unknown>).y, -100_000, 100_000)
    && numberIn((capture.bounds as Record<string, unknown>).width, 0, 100_000)
    && numberIn((capture.bounds as Record<string, unknown>).height, 0, 100_000)
    && !!element
    && boundedString(element.tag, 64)
    && boundedString(element.label, 1_024)
    && nullableString(element.role, 128)
    && boundedString(element.text, 4_096)
    && boundedString(element.html, 16_384)
    && validSource(capture.source)
    && Array.isArray(owners) && owners.length <= 16 && owners.every((owner) => {
      if (!owner || typeof owner !== "object") return false;
      const item = owner as Record<string, unknown>;

      return boundedString(item.componentName, 256) && nullableString(item.filePath, 1_024)
        && nullableNumber(item.lineNumber) && nullableNumber(item.columnNumber)
        && (item.role === "component-owner" || item.role === "caller")
        && ["application", "library", "unknown"].includes(String(item.ownership));
    })
    && Array.isArray(ancestry) && ancestry.length <= 16 && ancestry.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;

      return boundedString(item.tag, 64) && boundedString(item.label, 256) && nullableString(item.selector, 2_048) && nullableString(item.testId, 512) && typeof item.selected === "boolean";
    })
    && !!support && (support.status === "supported" || support.status === "unsupported") && nullableString(support.reason, 1_024)
    && validFingerprint(capture.fingerprint)
    && boundedStringRecord(capture.computedStyles)
    && validScreenshot(capture.screenshot);
}

export function isShellMessage(value: unknown): value is ShellToBridgeMessage {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;

  if (r.protocol !== BRIDGE_PROTOCOL || !boundedString(r.session, 128) || !boundedString(r.generation, 128)) return false;

  if (r.kind === "selection-mode" || r.kind === "canvas-controls") return typeof r.enabled === "boolean";

  if (r.kind === "picker-visibility") return typeof r.hidden === "boolean";

  if (r.kind === "selection-markers") return Array.isArray(r.selectionIds) && r.selectionIds.length <= 8
    && r.selectionIds.every(id => boundedString(id, 128) && id.length > 0) && new Set(r.selectionIds).size === r.selectionIds.length;

  if (r.kind === "picker-refine") return ["parent", "child", "overlap-next", "overlap-previous", "attach"].includes(String(r.action));

  if (r.kind === "reload" || r.kind === "connect") return true;

  if (r.kind === "navigate") return boundedString(r.route, 4096) && boundedString(r.navigationId, 128);

  return r.kind === "revalidate" && boundedString(r.selectionId, 128) && validFingerprint(r.fingerprint);
}
