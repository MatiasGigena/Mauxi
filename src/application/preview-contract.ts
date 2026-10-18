import { Type } from "typebox";
import { Check } from "typebox/schema";

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
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "revalidate"; session: string; generation: string; selectionId: string; fingerprint: ElementFingerprint }
  | { protocol: typeof BRIDGE_PROTOCOL; kind: "highlight"; session: string; generation: string; selector: string | null; label: string };

const boundedString = (limit: number, min = 0) => Type.Refine(Type.String(), (value) => value.length >= min && value.length <= limit);

const nullableString = (limit: number) => Type.Union([Type.Null(), boundedString(limit)]);

const nullableNumber = Type.Union([Type.Null(), Type.Number()]);

const numberIn = (minimum: number, maximum: number) => Type.Number({ minimum, maximum });

const nullableInteger = (minimum: number) => Type.Union([Type.Null(), Type.Integer({ minimum, maximum: 1_000_000 })]);

const ownership = Type.Union([Type.Literal("application"), Type.Literal("library"), Type.Literal("unknown")]);

const boundedStringRecord = Type.Refine(
  Type.Record(Type.String(), boundedString(2_048)),
  (value) => {
    const keys = Object.keys(value);

    return keys.length <= 64 && keys.every((key) => key.length <= 128);
  },
);

const sourceSchema = Type.Object({
  filePath: boundedString(1_024),
  lineNumber: nullableInteger(1),
  columnNumber: nullableInteger(0),
  componentName: nullableString(256),
  method: Type.Union([Type.Literal("react-grab"), Type.Literal("jsx-attribute"), Type.Literal("unresolved")]),
  fileFingerprint: nullableString(128),
  role: Type.Union([Type.Literal("jsx-element"), Type.Literal("component-owner"), Type.Literal("caller"), Type.Literal("unknown")]),
  ownership,
  verification: Type.Union([Type.Literal("unverified"), Type.Literal("verified"), Type.Literal("missing-or-ambiguous"), Type.Literal("library")]),
});

const fingerprintSchema = Type.Object({
  selector: nullableString(2_048),
  tag: boundedString(64),
  testId: nullableString(512),
  text: boundedString(4_096),
  sourceKey: nullableString(1_024),
  instanceKey: boundedString(128),
});

const screenshotSchema = Type.Object({
  status: Type.Union([Type.Literal("pending"), Type.Literal("captured"), Type.Literal("unavailable")]),
  crop: Type.Object({
    x: numberIn(-10_000, 20_000),
    y: numberIn(-10_000, 20_000),
    width: numberIn(1, 10_000),
    height: numberIn(1, 10_000),
    space: Type.Literal("preview-css-pixels"),
  }),
  path: Type.Optional(boundedString(4_096)),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  capturedAt: Type.Optional(boundedString(64)),
  reason: Type.Optional(boundedString(1_024)),
});

const ownerSchema = Type.Object({
  componentName: boundedString(256),
  filePath: nullableString(1_024),
  lineNumber: nullableNumber,
  columnNumber: nullableNumber,
  role: Type.Union([Type.Literal("component-owner"), Type.Literal("caller")]),
  ownership,
});

const ancestrySchema = Type.Object({
  tag: boundedString(64),
  label: boundedString(256),
  selector: nullableString(2_048),
  testId: nullableString(512),
  selected: Type.Boolean(),
});

const captureSchema = Type.Object({
  selectionId: boundedString(128),
  documentGeneration: boundedString(128),
  capturedAt: boundedString(64),
  url: boundedString(4_096),
  viewport: Type.Object({ width: numberIn(1, 10_000), height: numberIn(1, 10_000), deviceScaleFactor: numberIn(.25, 8) }),
  coordinates: Type.Object({ clientX: numberIn(-10_000, 20_000), clientY: numberIn(-10_000, 20_000), space: Type.Literal("preview-css-pixels") }),
  bounds: Type.Object({ x: numberIn(-100_000, 100_000), y: numberIn(-100_000, 100_000), width: numberIn(0, 100_000), height: numberIn(0, 100_000) }),
  element: Type.Object({
    tag: boundedString(64),
    label: boundedString(1_024),
    role: nullableString(128),
    text: boundedString(4_096),
    html: boundedString(16_384),
  }),
  source: sourceSchema,
  componentOwners: Type.Array(ownerSchema, { maxItems: 16 }),
  domAncestry: Type.Array(ancestrySchema, { maxItems: 16 }),
  support: Type.Object({ status: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]), reason: nullableString(1_024) }),
  fingerprint: fingerprintSchema,
  computedStyles: boundedStringRecord,
  screenshot: screenshotSchema,
});

const envelope = {
  protocol: Type.Literal(BRIDGE_PROTOCOL),
  session: boundedString(128),
  generation: boundedString(128),
};

const bridgeMessageSchema = Type.Union([
  Type.Object({ ...envelope, kind: Type.Literal("canvas-shortcut"), action: Type.Union([Type.Literal("exit"), Type.Literal("space"), Type.Literal("space-end")]) }),
  Type.Object({
    ...envelope,
    kind: Type.Literal("canvas-zoom"),
    deltaY: numberIn(-100_000, 100_000),
    deltaMode: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
    clientX: numberIn(0, 10_000),
    clientY: numberIn(0, 10_000),
  }),
  Type.Object({ ...envelope, kind: Type.Union([Type.Literal("selection-cancelled"), Type.Literal("navigation-blocked")]) }),
  Type.Object({ ...envelope, kind: Type.Literal("route"), url: boundedString(4096), navigationId: nullableString(128), safe: Type.Boolean() }),
  Type.Object({ ...envelope, kind: Type.Literal("ready"), url: boundedString(4_096), viewport: Type.Object({ width: Type.Number(), height: Type.Number() }), reactGrab: Type.Boolean() }),
  Type.Object({
    ...envelope,
    kind: Type.Literal("revalidation"),
    selectionId: boundedString(128),
    status: Type.Union([Type.Literal("valid"), Type.Literal("stale")]),
    reason: Type.Optional(boundedString(1_024)),
  }),
  Type.Object({
    ...envelope,
    kind: Type.Literal("selection"),
    interaction: Type.Optional(Type.Union([Type.Literal("pointer"), Type.Literal("keyboard")])),
    capture: captureSchema,
  }),
]);

const shellMessageSchema = Type.Union([
  Type.Object({ ...envelope, kind: Type.Union([Type.Literal("selection-mode"), Type.Literal("canvas-controls")]), enabled: Type.Boolean() }),
  Type.Object({ ...envelope, kind: Type.Literal("picker-visibility"), hidden: Type.Boolean() }),
  Type.Object({ ...envelope, kind: Type.Literal("selection-markers"), selectionIds: Type.Array(boundedString(128, 1), { maxItems: 8, uniqueItems: true }) }),
  Type.Object({
    ...envelope,
    kind: Type.Literal("picker-refine"),
    action: Type.Union([Type.Literal("parent"), Type.Literal("child"), Type.Literal("overlap-next"), Type.Literal("overlap-previous"), Type.Literal("attach")]),
  }),
  Type.Object({ ...envelope, kind: Type.Union([Type.Literal("reload"), Type.Literal("connect")]) }),
  Type.Object({ ...envelope, kind: Type.Literal("navigate"), route: boundedString(4096), navigationId: boundedString(128) }),
  Type.Object({ ...envelope, kind: Type.Literal("revalidate"), selectionId: boundedString(128), fingerprint: fingerprintSchema }),
  Type.Object({ ...envelope, kind: Type.Literal("highlight"), selector: nullableString(1_024), label: boundedString(160) }),
]);

export function isBridgeMessage(value: unknown): value is BridgeToShellMessage {
  return Check(bridgeMessageSchema, value);
}

export function isShellMessage(value: unknown): value is ShellToBridgeMessage {
  return Check(shellMessageSchema, value);
}
