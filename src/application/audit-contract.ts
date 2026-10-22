import { Type, type Static } from "typebox";
import { Check } from "typebox/schema";

const text = (limit: number) => Type.Refine(Type.String(), (value) => value.length <= limit);
const nullableText = (limit: number) => Type.Union([Type.Null(), text(limit)]);
const finite = Type.Refine(Type.Number(), (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000);

export const RectSchema = Type.Object({ x: finite, y: finite, width: finite, height: finite });

const SourceHintSchema = Type.Object({ component: nullableText(256), file: nullableText(1_024), line: Type.Union([Type.Null(), Type.Integer({ minimum: 1, maximum: 1_000_000 })]), verified: Type.Optional(Type.Boolean()) });

export const AuditElementSchema = Type.Object({
  selector: text(1_024),
  tag: text(64),
  label: text(160),
  testId: nullableText(512),
  source: Type.Union([Type.Null(), SourceHintSchema]),
  rect: RectSchema,
});

const ScrollerSchema = Type.Object({
  overflowX: text(16),
  intentional: Type.Boolean(),
  signals: Type.Array(text(64), { maxItems: 12 }),
  keyboard: Type.Boolean(),
  named: Type.Boolean(),
  role: nullableText(64),
});

const PageIssueSchema = Type.Object({
  kind: Type.Union([Type.Literal("page-overflow"), Type.Literal("clipped-by-page"), Type.Literal("scroller"), Type.Literal("hidden-overflow"), Type.Literal("text-clipped"), Type.Literal("target-size"), Type.Literal("sticky-obstruction")]),
  element: AuditElementSchema,
  overflowPx: Type.Optional(finite),
  detail: Type.Optional(text(512)),
  scroller: Type.Optional(ScrollerSchema),
  ellipsis: Type.Optional(Type.Boolean()),
  coverage: Type.Optional(finite),
});

/** The page measurement lists at most this many issues; a full list may have dropped more. */
export const PAGE_ISSUE_LIMIT = 160;

export const PageMeasurementSchema = Type.Object({
  url: text(4_096),
  viewport: Type.Object({ width: finite, height: finite }),
  documentHeight: finite,
  pageOverflowPx: finite,
  pageClipsX: Type.Boolean(),
  viewportMeta: Type.Object({ present: Type.Boolean(), content: text(512), deviceWidth: Type.Boolean(), zoomBlocked: Type.Boolean() }),
  issues: Type.Array(PageIssueSchema, { maxItems: PAGE_ISSUE_LIMIT }),
  visited: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  truncated: Type.Boolean(),
  /** Elements for MeasureOptions.targets, in order; null when a selector no longer matches. */
  targets: Type.Optional(Type.Array(Type.Union([Type.Null(), AuditElementSchema]), { maxItems: 200 })),
});

export type AuditRect = Static<typeof RectSchema>;

export type AuditSourceHint = Static<typeof SourceHintSchema>;

export type AuditElement = Static<typeof AuditElementSchema>;

export type PageIssue = Static<typeof PageIssueSchema>;

export type PageMeasurement = Static<typeof PageMeasurementSchema>;

export function isPageMeasurement(value: unknown): value is PageMeasurement {
  return Check(PageMeasurementSchema, value);
}

export interface MeasureOptions {
  /** Run the slower per-profile checks (text clipping, target size, sticky coverage) in addition to overflow. */
  full: boolean;
  maxElements: number;
  /** CSS selectors reported by axe-core to describe with the same element model as Mauxi's own findings. */
  targets?: string[];
}

export interface AuditProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  note?: string;
  textSpacing?: boolean;
  /** Run axe-core here: once per distinct breakpoint layout, since its rules rarely change between neighbouring widths. */
  axe?: boolean;
  /** Capture only the viewport instead of the full page, to show what fits on screen. */
  viewportOnly?: boolean;
}

/** Profiles measured with every check and captured as a canvas board each, in board order. The width sweep below covers the gaps between them. */
export const AUDIT_PROFILES: readonly AuditProfile[] = [
  { id: "phone-sm", label: "Small phone", width: 320, height: 568, note: "WCAG 1.4.10 reflow width", axe: true },
  { id: "android", label: "Android", width: 360, height: 800 },
  { id: "phone", label: "Phone", width: 390, height: 844, axe: true },
  { id: "phone-lg", label: "Large phone", width: 430, height: 932 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, axe: true },
  { id: "phone-landscape", label: "Phone landscape", width: 844, height: 390, note: "WCAG 1.3.4 orientation" },
  { id: "tablet-landscape", label: "Tablet landscape", width: 1024, height: 768, axe: true },
  { id: "laptop", label: "Laptop", width: 1280, height: 800, axe: true },
  { id: "laptop-hd", label: "HD laptop", width: 1366, height: 768 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900, axe: true },
  { id: "desktop-wide", label: "Wide desktop", width: 1920, height: 1080, axe: true },
  { id: "zoom-200", label: "200% zoom", width: 640, height: 512, note: "1280×1024 at 200% zoom", viewportOnly: true },
  { id: "zoom-400", label: "400% zoom", width: 320, height: 256, note: "1280×1024 at 400% zoom", viewportOnly: true },
  { id: "text-spacing", label: "Text spacing", width: 320, height: 568, note: "WCAG 1.4.12 overrides", textSpacing: true },
  { id: "text-spacing-wide", label: "Text spacing (wide)", width: 1280, height: 800, note: "WCAG 1.4.12 overrides", textSpacing: true },
];

export const SWEEP_HEIGHT = 900;

export function sweepWidths(): number[] {
  const widths: number[] = [];

  for (let width = 320; width <= 1440; width += 16) widths.push(width);

  return [...widths, 1600, 1920];
}

export type FindingKind =
  | "page-overflow"
  | "clipped-by-page"
  | "scroller-review"
  | "scroller-a11y"
  | "content-clipped"
  | "text-truncated"
  | "text-spacing-clipped"
  | "target-size"
  | "sticky-obstruction"
  | "zoom-blocked"
  | "viewport-meta"
  | "focus-obscured"
  | "focus-not-visible"
  | "disclosure-overflow"
  | "hover-content"
  | "axe";

export type FindingSeverity = "serious" | "moderate" | "minor";

/** bug: fix it; review: likely a bug, a person decides; intentional: deliberate pattern with an accessibility gap. */
export type FindingClassification = "bug" | "review" | "intentional";

export interface FindingCriterion { id: string; name: string }

export interface FindingMarker { profileId: string; rect: AuditRect }

export interface AuditFinding {
  id: string;
  kind: FindingKind;
  title: string;
  detail: string;
  fixHint: string;
  criterion: FindingCriterion | null;
  severity: FindingSeverity;
  classification: FindingClassification;
  element: AuditElement | null;
  /** Inclusive CSS-pixel width ranges where the problem was measured. */
  ranges: Array<[number, number]>;
  worst: { width: number; height: number; overflowPx?: number };
  profiles: string[];
  markers: FindingMarker[];
  /** The axe-core rule behind an "axe" finding; url is set only for Deque rule documentation. */
  rule?: { id: string; help: string; url: string | null };
}

export interface AuditScroller {
  key: string;
  element: AuditElement;
  signals: string[];
  ranges: Array<[number, number]>;
}

export interface AuditSnapshot {
  profileId: string;
  label: string;
  note?: string;
  width: number;
  height: number;
  imageHeight: number;
  image: string;
}

export interface AuditReport {
  url: string;
  route: string;
  startedAt: string;
  durationMs: number;
  widthsScanned: number;
  profiles: Array<AuditProfile & { issueCount: number }>;
  snapshots: AuditSnapshot[];
  findings: AuditFinding[];
  scrollers: AuditScroller[];
  resolved: AuditFinding[];
  /** Previous findings no longer reported whose check did not run completely this time (layout scan truncated, axe failed or cut off, interaction pass skipped or stopped). */
  unverified?: AuditFinding[];
  summary: { bug: number; review: number; intentional: number; serious: number; moderate: number; minor: number };
  /** Keyboard focus, disclosure and hover checks; absent when the pass did not run. */
  interactions?: AuditInteractionSummary;
  /** General checks by axe-core at the width profiles; note explains a failed or partial run. */
  axe?: AuditAxeInfo;
}

export interface AuditAxeInfo { version: string | null; profiles: string[]; durationMs: number; note: string | null }

export interface AuditInteractionSummary { durationMs: number; profiles: string[]; focusStops: number; disclosures: number; hovers: number; notes: string[] }

export interface AuditProgress { phase: "loading" | "sweep" | "profiles" | "interactions" | "done"; done: number; total: number; width?: number; site?: AuditSiteStep }

/** Where a site audit is: the zero-based page index of the batch and its route. */
export interface AuditSiteStep { index: number; total: number; route: string }

export interface AuditRunRequest { workspaceId?: string; route: string }

/** The compact form attached to agent requests: no images or marker geometry. */
export interface AuditFindingContext {
  id: string;
  kind: FindingKind;
  title: string;
  detail: string;
  fixHint: string;
  criterion: string | null;
  severity: FindingSeverity;
  classification: FindingClassification;
  ranges: Array<[number, number]>;
  worstWidth: number;
  route: string;
  element: { selector: string; tag: string; label: string; testId: string | null; source: AuditSourceHint | null } | null;
}

const FindingContextSchema = Type.Object({
  id: text(128),
  kind: Type.Union([
    Type.Literal("page-overflow"), Type.Literal("clipped-by-page"), Type.Literal("scroller-review"), Type.Literal("scroller-a11y"), Type.Literal("content-clipped"), Type.Literal("text-truncated"),
    Type.Literal("text-spacing-clipped"), Type.Literal("target-size"), Type.Literal("sticky-obstruction"), Type.Literal("zoom-blocked"), Type.Literal("viewport-meta"),
    Type.Literal("focus-obscured"), Type.Literal("focus-not-visible"), Type.Literal("disclosure-overflow"), Type.Literal("hover-content"),
    Type.Literal("axe"),
  ]),
  title: text(512),
  detail: text(2_048),
  fixHint: text(2_048),
  criterion: nullableText(128),
  severity: Type.Union([Type.Literal("serious"), Type.Literal("moderate"), Type.Literal("minor")]),
  classification: Type.Union([Type.Literal("bug"), Type.Literal("review"), Type.Literal("intentional")]),
  ranges: Type.Array(Type.Tuple([finite, finite]), { maxItems: 64 }),
  worstWidth: finite,
  route: text(4_096),
  element: Type.Union([Type.Null(), Type.Object({ selector: text(1_024), tag: text(64), label: text(160), testId: nullableText(512), source: Type.Union([Type.Null(), SourceHintSchema]) })]),
});

export const FindingContextListSchema = Type.Array(FindingContextSchema, { maxItems: 12 });

export function findingContext(finding: AuditFinding, route: string): AuditFindingContext {
  const element = finding.element && { selector: finding.element.selector, tag: finding.element.tag, label: finding.element.label, testId: finding.element.testId, source: finding.element.source };

  return {
    id: finding.id, kind: finding.kind, title: finding.title, detail: finding.detail, fixHint: finding.fixHint,
    criterion: finding.criterion ? `WCAG ${finding.criterion.id} ${finding.criterion.name}` : null,
    severity: finding.severity, classification: finding.classification, ranges: finding.ranges.slice(0, 64), worstWidth: finding.worst.width, route, element,
  };
}

export function formatRanges(ranges: Array<[number, number]>): string {
  return ranges.map(([from, to]) => from === to ? `${from}px` : to >= 1920 ? `${from}px+` : `${from}–${to}px`).join(", ");
}

export const PageLinksSchema = Type.Object({
  url: text(4_096),
  links: Type.Array(Type.Object({ href: text(4_096), download: Type.Boolean() }), { maxItems: 400 }),
  total: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
});

export type PageLinks = Static<typeof PageLinksSchema>;

export function isPageLinks(value: unknown): value is PageLinks {
  return Check(PageLinksSchema, value);
}

export interface DiscoveredRoute { route: string; depth: number; from: string | null }

export interface ExcludedRoute { route: string; reason: string }

export interface RouteDiscovery {
  start: string;
  routes: DiscoveredRoute[];
  /** Same-origin links that were left out, with the reason. */
  excluded: ExcludedRoute[];
  external: number;
  pagesVisited: number;
  truncated: boolean;
}

export type AuditSitePageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface AuditSitePage {
  route: string;
  status: AuditSitePageStatus;
  summary: AuditReport["summary"] | null;
  /** Width ranges of the page's bugs, unmerged. */
  bugRanges: Array<[number, number]>;
  resolved: number;
  durationMs: number;
  error?: string;
}

export interface AuditSiteReport { id: string; startedAt: string; durationMs: number; state: "running" | "done" | "cancelled"; pages: AuditSitePage[] }

/** Which workspace an audit request targets: the active one, or a proof fixture. */
export interface AuditScope { workspaceId?: string; fixture?: "vite" | "next" | "next-turbopack" }
