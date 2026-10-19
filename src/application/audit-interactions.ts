import { Type, type Static } from "typebox";
import { Check } from "typebox/schema";
import { AuditElementSchema, RectSchema, type AuditElement, type AuditFinding, type AuditSnapshot, type FindingCriterion, type FindingKind, type FindingMarker } from "./audit-contract";

const text = (limit: number) => Type.Refine(Type.String(), (value) => value.length <= limit);
const finite = Type.Refine(Type.Number(), (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000);

/** Profiles that get the keyboard focus walk and the disclosure pass, in run order; hover runs last, at the final one. */
export const INTERACTION_PROFILE_IDS = ["zoom-400", "phone-sm"] as const;
export const INTERACTION_LIMITS = { focusStops: 40, disclosures: 6, hovers: 6, issuesPerWalk: 12, budgetMs: 20_000 } as const;

const InteractionIssueSchema = Type.Object({
  kind: Type.Union([Type.Literal("focus-obscured"), Type.Literal("focus-not-visible"), Type.Literal("disclosure-overflow"), Type.Literal("hover-content")]),
  /** full/partial: share of the focused element under a bar; none/subtle/offscreen: focus indicator; overflow/clipped/unhoverable: opened or hover content. */
  variant: Type.Union([Type.Literal("full"), Type.Literal("partial"), Type.Literal("none"), Type.Literal("subtle"), Type.Literal("offscreen"), Type.Literal("overflow"), Type.Literal("clipped"), Type.Literal("unhoverable")]),
  /** The element the finding is about: the focused element, the opened content or the hover trigger. */
  element: AuditElementSchema,
  /** The covering bar, the disclosure trigger or the revealed tooltip. */
  cause: Type.Optional(AuditElementSchema),
  /** Viewport-relative position at measurement time, for markers on the interaction snapshot. */
  view: RectSchema,
  overflowPx: Type.Optional(finite),
  detail: text(512),
});

const PointSchema = Type.Object({ x: finite, y: finite });

export const InteractionResultSchema = Type.Object({
  done: Type.Optional(Type.Boolean()),
  reason: Type.Optional(text(512)),
  label: Type.Optional(text(160)),
  count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  point: Type.Optional(Type.Union([Type.Null(), PointSchema])),
  opened: Type.Optional(Type.Boolean()),
  restored: Type.Optional(Type.Boolean()),
  urlChanged: Type.Optional(Type.Boolean()),
  skipped: Type.Optional(Type.Array(text(512), { maxItems: 16 })),
  issues: Type.Optional(Type.Array(InteractionIssueSchema, { maxItems: 16 })),
});

export type InteractionIssue = Static<typeof InteractionIssueSchema>;

export type InteractionResult = Static<typeof InteractionResultSchema>;

export function isInteractionResult(value: unknown): value is InteractionResult {
  return Check(InteractionResultSchema, value);
}

/** One in-page step of the interaction pass; the host dispatches the real key and pointer events between steps. */
export type InteractionRequest =
  | { action: "focus-start" | "focus-measure" | "disclosure-list" | "hover-list" | "cleanup"; index?: number }
  | { action: "disclosure-target" | "disclosure-measure" | "disclosure-check" | "disclosure-force-close" | "hover-target" | "hover-measure" | "hover-check"; index: number };

export interface InteractionSample { profileId: string; width: number; height: number; issue: InteractionIssue; snapshotId: string | null }

export interface InteractionRun { durationMs: number; profiles: string[]; focusStops: number; disclosures: number; hovers: number; notes: string[]; samples: InteractionSample[]; snapshots: AuditSnapshot[] }

const FOCUS_NOT_OBSCURED: FindingCriterion = { id: "2.4.11", name: "Focus Not Obscured (Minimum)" };
const FOCUS_VISIBLE: FindingCriterion = { id: "2.4.7", name: "Focus Visible" };
const REFLOW: FindingCriterion = { id: "1.4.10", name: "Reflow" };
const CONTENT_ON_HOVER: FindingCriterion = { id: "1.4.13", name: "Content on Hover or Focus" };

const elementKey = (element: AuditElement) => `${element.selector}|${element.source?.file ?? ""}`;
const viewport = (sample: InteractionSample) => `${sample.width}×${sample.height}`;
const list = (values: string[], limit = 3) => [...new Set(values)].slice(0, limit).join(", ") + (new Set(values).size > limit ? ` and ${new Set(values).size - limit} more` : "");

function groupBy(samples: InteractionSample[], key: (sample: InteractionSample) => string): InteractionSample[][] {
  const groups = new Map<string, InteractionSample[]>();

  for (const sample of samples) groups.set(key(sample), [...(groups.get(key(sample)) ?? []), sample]);

  return [...groups.values()];
}

function markersOf(samples: InteractionSample[]): FindingMarker[] {
  const result: FindingMarker[] = [];

  for (const sample of samples) if (sample.snapshotId && !result.some((marker) => marker.profileId === sample.snapshotId)) result.push({ profileId: sample.snapshotId, rect: sample.issue.view });

  return result;
}

/**
 * Turns interaction samples into findings grouped by element across profiles. Focus hidden behind fixed bars confirms
 * an existing static "fixed bars cover the screen" finding when there is one, otherwise it is reported per bar.
 */
export function interactionFindings(run: InteractionRun, existing: AuditFinding[], findingId: (kind: FindingKind, element: AuditElement) => string): AuditFinding[] {
  const findings: AuditFinding[] = [];

  const finding = (kind: FindingKind, items: InteractionSample[], element: AuditElement, options: Pick<AuditFinding, "title" | "detail" | "fixHint" | "criterion" | "severity" | "classification">): AuditFinding => {
    const worst = items.reduce((best, item) => (item.issue.overflowPx ?? 0) > (best.issue.overflowPx ?? 0) || (best.height > item.height && (item.issue.overflowPx ?? 0) === (best.issue.overflowPx ?? 0)) ? item : best, items[0]);
    const widths = [...new Set(items.map((item) => item.width))].sort((a, b) => a - b);

    const result: AuditFinding = {
      id: findingId(kind, element), kind, ...options, element,
      ranges: widths.map((width): [number, number] => [width, width]),
      worst: { width: worst.width, height: worst.height },
      profiles: [...new Set(items.map((item) => item.profileId))], markers: markersOf(items),
    };

    if (worst.issue.overflowPx !== undefined) result.worst.overflowPx = worst.issue.overflowPx;

    return result;
  };

  const covered = groupBy(run.samples.filter((sample) => sample.issue.kind === "focus-obscured" && sample.issue.cause), (sample) => elementKey(sample.issue.cause!));

  const evidence = (items: InteractionSample[]) => {
    const full = items.filter((item) => item.issue.variant === "full");
    const shown = full.length ? full : items;
    const stops = new Set(shown.map((item) => item.issue.element.selector)).size;

    return `${stops} focus ${stops === 1 ? "stop" : "stops"} ${full.length ? "entirely" : "partly"} hidden behind ${items[0].issue.cause!.selector} at ${list(shown.map(viewport))} (${list(shown.map((item) => `${item.issue.element.tag} "${item.issue.element.label}"`))})`;
  };

  // One root cause, one finding: when the static coverage check already reported the bars, the walk's evidence for
  // every bar is attached to it (without extra snapshot boards) instead of adding findings next to it.
  const sticky = existing.find((item) => item.kind === "sticky-obstruction" && covered.some((items) => item.element && elementKey(item.element) === elementKey(items[0].issue.cause!))) ?? existing.find((item) => item.kind === "sticky-obstruction");

  if (sticky && covered.length) {
    sticky.detail = `${sticky.detail} Keyboard focus walk: ${covered.map(evidence).join("; ")}.`.slice(0, 2_000);
    sticky.profiles = [...new Set([...sticky.profiles, ...covered.flat().map((item) => item.profileId)])];

    if (covered.flat().some((item) => item.issue.variant === "full")) { sticky.classification = "bug"; sticky.severity = "serious"; }
  }

  for (const items of sticky ? [] : covered) {
    const bar = items[0].issue.cause!;
    const full = items.filter((item) => item.issue.variant === "full");
    const where = list((full.length ? full : items).map(viewport));
    findings.push(finding("focus-obscured", items, bar, {
      title: full.length ? `Keyboard focus hidden behind a fixed bar at ${where}` : `Keyboard focus partly hidden behind a fixed bar at ${where}`,
      detail: `${(full[0] ?? items[0]).issue.detail} Keyboard focus walk: ${evidence(items)}.`,
      fixHint: "Add scroll-padding equal to the bars' heights (html { scroll-padding-top: <header height>; scroll-padding-bottom: <bar height> }) so focused elements scroll clear of them, and make the bar static or collapsible at short viewports (@media (max-height: 400px) { position: static }).",
      criterion: FOCUS_NOT_OBSCURED, severity: full.length ? "serious" : "moderate", classification: full.length ? "bug" : "review",
    }));
  }

  for (const items of groupBy(run.samples.filter((sample) => sample.issue.kind === "focus-not-visible"), (sample) => elementKey(sample.issue.element))) {
    const variant = items.some((item) => item.issue.variant === "offscreen") ? "offscreen" : items.some((item) => item.issue.variant === "none") ? "none" : "subtle";
    const sample = items.find((item) => item.issue.variant === variant) ?? items[0];
    findings.push(finding("focus-not-visible", items, sample.issue.element, {
      title: variant === "offscreen" ? "Keyboard focus lands on an element that is not on screen" : variant === "none" ? "No visible focus indicator" : "Focus indicator is subtle",
      detail: `${sample.issue.detail} Measured at ${list(items.map(viewport))}.${variant === "offscreen" ? "" : " Compared with its computed style before any element had focus; an indicator drawn by another element would not be seen, so a person confirms."}`,
      fixHint: variant === "offscreen"
        ? "Keep hidden content out of the tab order while it is not shown (display: none, visibility: hidden or the inert attribute on the closed drawer), or bring it on screen when it receives focus."
        : variant === "none"
          ? "Do not remove the outline without a replacement: add a :focus-visible style such as outline: 2px solid currentColor; outline-offset: 2px, or a box-shadow ring."
          : "Add a non-color indicator on :focus-visible (an outline or box-shadow ring with at least 3:1 contrast) instead of relying on a color or underline change.",
      criterion: FOCUS_VISIBLE, severity: variant === "subtle" ? "minor" : "serious", classification: "review",
    }));
  }

  for (const items of groupBy(run.samples.filter((sample) => sample.issue.kind === "disclosure-overflow"), (sample) => elementKey(sample.issue.element))) {
    const sample = items.reduce((best, item) => (item.issue.overflowPx ?? 0) > (best.issue.overflowPx ?? 0) ? item : best, items[0]);
    findings.push(finding("disclosure-overflow", items, sample.issue.element, {
      title: `Opened ${sample.issue.cause?.tag === "summary" ? "disclosure" : "menu"} ${sample.issue.variant === "clipped" ? "is cut off" : "overflows the viewport"} at ${list(items.map(viewport))}`,
      detail: `${sample.issue.detail}${sample.issue.cause ? ` Opened with ${sample.issue.cause.tag} "${sample.issue.cause.label}".` : ""}`,
      fixHint: "Size the opened content fluidly (width: min(<size>, 100%) or max-width: calc(100vw - 2rem)), keep it anchored inside the viewport, and give fixed menus max-height: 100dvh with overflow-y: auto so every item stays reachable at 320px and 400% zoom.",
      criterion: REFLOW, severity: "serious", classification: "bug",
    }));
  }

  for (const items of groupBy(run.samples.filter((sample) => sample.issue.kind === "hover-content"), (sample) => elementKey(sample.issue.element))) {
    const clipped = items.find((item) => item.issue.variant === "clipped");
    const unhoverable = items.find((item) => item.issue.variant === "unhoverable");
    findings.push(finding("hover-content", items, items[0].issue.element, {
      title: clipped ? `Hover content cut off at ${viewport(clipped)}` : "Hover content disappears when the pointer moves onto it",
      detail: [clipped?.issue.detail, unhoverable?.issue.detail].filter(Boolean).join(" "),
      fixHint: clipped
        ? "Keep the tooltip inside the viewport: flip or shift it near the edges and cap its width (max-width: calc(100vw - 2rem)); also keep it open while the pointer moves onto it and close it on Escape."
        : "Keep the tooltip open while the pointer moves onto it (make it a descendant of the hover target or bridge the gap between them) and close it on Escape.",
      criterion: CONTENT_ON_HOVER, severity: clipped ? "serious" : "moderate", classification: clipped ? "bug" : "review",
    }));
  }

  return findings;
}
