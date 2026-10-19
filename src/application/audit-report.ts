import type { AuditAxeInfo, AuditElement, AuditFinding, AuditProfile, AuditReport, AuditScroller, AuditSnapshot, FindingClassification, FindingCriterion, FindingKind, FindingMarker, FindingSeverity, PageIssue, PageMeasurement } from "./audit-contract";
import { formatRanges } from "./audit-contract";
import { AXE_NODE_LIMIT, axeCriterion, axeFix, isAxeHelpUrl, type AxeImpact, type AxeProfileResult } from "./audit-axe";
import { interactionFindings, type InteractionRun } from "./audit-interactions";

export interface AuditSample { width: number; height: number; profile: AuditProfile | null; measurement: PageMeasurement; axe?: AxeProfileResult[] }

interface Occurrence { sample: AuditSample; issue: PageIssue }

const REFLOW: FindingCriterion = { id: "1.4.10", name: "Reflow" };
const TEXT_SPACING: FindingCriterion = { id: "1.4.12", name: "Text Spacing" };
const TARGET_SIZE: FindingCriterion = { id: "2.5.8", name: "Target Size (Minimum)" };
const FOCUS_NOT_OBSCURED: FindingCriterion = { id: "2.4.11", name: "Focus Not Obscured (Minimum)" };
const KEYBOARD: FindingCriterion = { id: "2.1.1", name: "Keyboard" };
const RESIZE_TEXT: FindingCriterion = { id: "1.4.4", name: "Resize Text" };

const INTERACTION_KINDS = new Set<FindingKind>(["focus-obscured", "focus-not-visible", "disclosure-overflow", "hover-content"]);

const CLASS_ORDER: Record<FindingClassification, number> = { bug: 0, review: 1, intentional: 2 };
const SEVERITY_ORDER: Record<FindingSeverity, number> = { serious: 0, moderate: 1, minor: 2 };
const IMPACT_SEVERITY: Record<NonNullable<AxeImpact>, FindingSeverity> = { critical: "serious", serious: "serious", moderate: "moderate", minor: "minor" };

function hash(value: string): string {
  let result = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) { result ^= value.charCodeAt(index); result = Math.imul(result, 0x01000193) >>> 0; }

  return result.toString(36);
}

const elementKey = (element: AuditElement) => `${element.selector}|${element.source?.file ?? ""}`;

function group<T>(occurrences: T[], key: (occurrence: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const occurrence of occurrences) {
    const id = key(occurrence);
    groups.set(id, [...(groups.get(id) ?? []), occurrence]);
  }

  return groups;
}

/** Merges widths into inclusive ranges, treating neighbouring scanned widths as contiguous. */
export function widthRanges(widths: number[], scanned: number[]): Array<[number, number]> {
  const order = [...new Set(scanned)].sort((a, b) => a - b);
  const present = new Set(widths);
  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  let previous: number | null = null;

  for (const width of order) {
    if (present.has(width)) { start ??= width; previous = width; continue; }

    if (start !== null && previous !== null) ranges.push([start, previous]);
    start = null; previous = null;
  }

  if (start !== null && previous !== null) ranges.push([start, previous]);

  return ranges;
}

function markers(occurrences: Occurrence[], snapshotProfiles: Set<string>): FindingMarker[] {
  const result: FindingMarker[] = [];

  for (const { sample, issue } of occurrences) {
    if (!sample.profile || !snapshotProfiles.has(sample.profile.id) || result.some((marker) => marker.profileId === sample.profile!.id)) continue;
    result.push({ profileId: sample.profile.id, rect: issue.element.rect });
  }

  return result;
}

function overflowFix(detail: string | undefined): string {
  if (detail?.includes("scrollbar")) return "Use width: 100% instead of 100vw, and drop min-width values equal to the viewport so the box fits beside the scrollbar.";

  if (detail?.includes("tracks are")) return "Size the tracks fluidly (repeat(auto-fit, minmax(min(100%, 16rem), 1fr)) or minmax(0, 1fr)) or drop to fewer columns in this width range instead of fixed track widths.";

  if (detail?.includes("children extend")) return "Let the container wrap (flex-wrap: wrap, or grid with repeat(auto-fit, minmax(min(100%, 16rem), 1fr))) and allow children to shrink with min-width: 0 instead of fixed widths.";

  if (detail?.includes("unbreakable") || detail?.includes("Text overflows")) return "Allow long strings to wrap: overflow-wrap: anywhere on the text container (and min-width: 0 on its flex/grid parent).";

  return "Replace the fixed width with a fluid one (max-width: 100%, width: min(100%, <size>), or minmax(0, 1fr) tracks) so the box never exceeds its container.";
}

function worstOf({ sample, issue }: Occurrence): AuditFinding["worst"] {
  const worst: AuditFinding["worst"] = { width: sample.width, height: sample.height };

  if (issue.overflowPx !== undefined) worst.overflowPx = issue.overflowPx;

  return worst;
}

export function buildReport(input: {
  url: string;
  route: string;
  startedAt: string;
  durationMs: number;
  samples: AuditSample[];
  snapshots: AuditSnapshot[];
  previous?: AuditReport | null;
  interactions?: InteractionRun;
  axe?: AuditAxeInfo;
}): AuditReport {
  const { samples } = input;
  const scanned = [...new Set(samples.filter((sample) => !sample.profile?.textSpacing).map((sample) => sample.width))].sort((a, b) => a - b);
  const widest = scanned[scanned.length - 1] ?? 0;
  const narrowest = scanned[0] ?? 320;
  const snapshotProfiles = new Set(input.snapshots.map((snapshot) => snapshot.profileId));
  const base = samples.filter((sample) => !sample.profile?.textSpacing);
  const findings: AuditFinding[] = [];
  const scrollers: AuditScroller[] = [];

  const occurrences = (kind: PageIssue["kind"], from: AuditSample[]) => from.flatMap((sample) => sample.measurement.issues.filter((issue) => issue.kind === kind).map((issue) => ({ sample, issue })));

  const add = (kind: FindingKind, items: Occurrence[], options: { title: string; detail: string; fixHint: string; criterion: FindingCriterion | null; severity: FindingSeverity; classification: FindingClassification; worst?: Occurrence }) => {
    const worst = options.worst ?? items.reduce((best, item) => (item.issue.overflowPx ?? 0) > (best.issue.overflowPx ?? 0) ? item : best, items[0]);
    const element = worst.issue.element;
    const widths = items.map((item) => item.sample.width);
    findings.push({
      id: `${kind}:${hash(elementKey(element))}`, kind, title: options.title, detail: options.detail, fixHint: options.fixHint,
      criterion: options.criterion, severity: options.severity, classification: options.classification, element,
      ranges: widthRanges(widths, [...scanned, ...items.map((item) => item.sample.width)]),
      worst: worstOf(worst),
      profiles: [...new Set(items.flatMap((item) => item.sample.profile ? [item.sample.profile.id] : []))],
      markers: markers(items, snapshotProfiles),
    });
  };

  // Horizontal page overflow and content cut off by the page.
  for (const kind of ["page-overflow", "clipped-by-page"] as const) {
    for (const items of group(occurrences(kind, base), (item) => elementKey(item.issue.element)).values()) {
      const widths = items.map((item) => item.sample.width);
      const ranges = widthRanges(widths, scanned);
      const atReflowWidth = Math.min(...widths) <= 320;
      const worst = items.reduce((best, item) => (item.issue.overflowPx ?? 0) > (best.issue.overflowPx ?? 0) ? item : best, items[0]);
      const amount = Math.round(worst.issue.overflowPx ?? 0);
      const where = formatRanges(ranges);
      add(kind, items, {
        worst,
        title: kind === "page-overflow" ? `Horizontal scroll at ${where}` : `Content cut off by overflow-x: hidden at ${where}`,
        detail: `${worst.issue.detail ?? ""} Worst case: ${amount}px past the edge at ${worst.sample.width}px.${atReflowWidth ? "" : " Not measured at 320px, so this is a breakpoint gap rather than a 1.4.10 failure."}`.trim(),
        fixHint: overflowFix(worst.issue.detail),
        criterion: atReflowWidth ? REFLOW : null,
        severity: atReflowWidth || amount >= 40 || kind === "clipped-by-page" ? "serious" : "moderate",
        classification: "bug",
      });
    }
  }

  // Horizontal scroll containers: deliberate scrollers keep scrolling but must be reachable; accidental ones are reviewed.
  for (const items of group(occurrences("scroller", base), (item) => elementKey(item.issue.element)).values()) {
    const widths = items.map((item) => item.sample.width);
    const signals = [...new Set(items.flatMap((item) => item.issue.scroller?.signals ?? []))];
    const atWidest = Math.max(...widths) >= widest && widest >= 1440;
    const intentional = items.some((item) => item.issue.scroller?.intentional) || atWidest;
    const ranges = widthRanges(widths, scanned);
    const element = items[items.length - 1].issue.element;

    if (intentional) {
      const allSignals = atWidest && !signals.length ? ["scrolls-at-all-widths"] : signals;
      scrollers.push({ key: elementKey(element), element, signals: allSignals, ranges });
      // Every occurrence counts: a scroller reachable at one profile can still be unreachable at another.
      const unreachable = items.filter((item) => item.issue.scroller && !item.issue.scroller.keyboard);
      const unnamed = items.filter((item) => item.issue.scroller?.role === "region" && !item.issue.scroller.named);
      const failing = items.filter((item) => unreachable.includes(item) || unnamed.includes(item));
      const problems = [...(unreachable.length ? ["it cannot be reached with the keyboard (no tabindex=\"0\" and no focusable children)"] : []), ...(unnamed.length ? ["role=\"region\" has no accessible name"] : [])];
      const where = failing.length < items.length ? ` at ${formatRanges(widthRanges(failing.map((item) => item.sample.width), scanned))}` : "";

      if (failing.length) add("scroller-a11y", failing, {
        title: "Intentional scroller is not keyboard accessible",
        detail: `Kept as a deliberate horizontal scroller (${allSignals.join(", ")}), but ${problems.join(" and ")}${where}. Safari does not focus scroll containers by default.`,
        fixHint: "Keep the scrolling. Add tabindex=\"0\", role=\"region\" and an aria-label to the scroll container (or give it focusable items), and keep a visible focus style.",
        criterion: KEYBOARD, severity: "moderate", classification: "intentional",
      });
    } else add("scroller-review", items, {
      title: `Container scrolls horizontally at ${formatRanges(ranges)}`,
      detail: `No carousel, table or code-block signals, and it only scrolls at narrower widths, so the inner horizontal scroll is probably accidental.${signals.length ? ` Weak signals: ${signals.join(", ")}.` : ""}`,
      fixHint: "If it is not meant to scroll, let its content wrap or shrink (flex-wrap, minmax(0, 1fr), min-width: 0). If it is a carousel, mark it as intentional in Mauxi and make it keyboard reachable.",
      criterion: Math.min(...widths) <= 320 ? REFLOW : null, severity: "moderate", classification: "review",
    });
  }

  for (const items of group(occurrences("hidden-overflow", base), (item) => elementKey(item.issue.element)).values()) {
    const widths = items.map((item) => item.sample.width);

    if (Math.max(...widths) >= widest) continue;
    add("content-clipped", items, {
      title: `Content hidden by overflow at ${formatRanges(widthRanges(widths, scanned))}`,
      detail: `${items[0].issue.detail ?? "Content is clipped."} The same container fits at wider widths, so narrow layouts lose content.`,
      fixHint: "Let the content wrap or stack at narrow widths instead of clipping it; if hiding is intended, provide another way to reach the hidden items.",
      criterion: Math.min(...widths) <= 320 ? REFLOW : null, severity: "moderate", classification: "review",
    });
  }

  // Clipped text: compare narrow profiles with wide ones, and text-spacing profiles with their base profile.
  const fullBase = base.filter((sample) => sample.profile);
  const wideKeys = new Set(occurrences("text-clipped", fullBase.filter((sample) => sample.width >= 1280)).map((item) => elementKey(item.issue.element)));

  for (const [key, items] of group(occurrences("text-clipped", fullBase), (item) => elementKey(item.issue.element))) {
    const ellipsis = items.some((item) => item.issue.ellipsis);

    if (wideKeys.has(key) && ellipsis) continue;
    const narrowOnly = !wideKeys.has(key);
    add(ellipsis ? "text-truncated" : "content-clipped", items, {
      title: ellipsis ? "Text truncated at narrow widths" : narrowOnly ? "Text cut off at narrow widths" : "Text cut off at every width",
      detail: `${items[0].issue.detail ?? ""}${narrowOnly ? " It fits at desktop widths, so the narrow layout loses information." : ""}`.trim(),
      fixHint: ellipsis ? "Make sure the full text is available elsewhere (title, expandable row, detail view), or let it wrap at narrow widths." : "Remove fixed heights/widths and white-space: nowrap from the text container so it can grow with its content.",
      criterion: REFLOW, severity: ellipsis ? "minor" : "moderate", classification: ellipsis || !narrowOnly ? "review" : "bug",
    });
  }

  for (const sample of samples.filter((item) => item.profile?.textSpacing)) {
    const baseline = fullBase.find((item) => item.width === sample.width && item.profile && !item.profile.textSpacing);
    const before = new Set((baseline?.measurement.issues ?? []).filter((issue) => issue.kind === "text-clipped").map((issue) => elementKey(issue.element)));
    const fresh = occurrences("text-clipped", [sample]).filter((item) => !before.has(elementKey(item.issue.element)));

    for (const items of group(fresh, (item) => elementKey(item.issue.element)).values()) {
      const existing = findings.find((finding) => finding.kind === "text-spacing-clipped" && finding.element && elementKey(finding.element) === elementKey(items[0].issue.element));

      if (existing) {
        existing.ranges = widthRanges([...existing.ranges.flat(), sample.width], [...scanned, sample.width]);
        existing.profiles = [...new Set([...existing.profiles, sample.profile!.id])];
        existing.markers = [...existing.markers, ...markers(items, snapshotProfiles)];
        continue;
      }

      add("text-spacing-clipped", items, {
        title: "Text clipped when users increase text spacing",
        detail: `${items[0].issue.detail ?? ""} Appears only after applying WCAG 1.4.12 overrides (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em).`.trim(),
        fixHint: "Avoid fixed heights and line-heights on text containers; use min-height and let boxes grow, and avoid overflow: hidden around text.",
        criterion: TEXT_SPACING, severity: "serious", classification: "bug",
      });
    }
  }

  // Target size and sticky coverage come from the full-check profiles.
  for (const items of group(occurrences("target-size", fullBase), (item) => elementKey(item.issue.element)).values()) {
    add("target-size", items, {
      title: "Touch target smaller than 24×24px",
      detail: items[0].issue.detail ?? "Small target close to another target.",
      fixHint: "Give the control at least 24×24 CSS px (min-width/min-height or padding), or space it so a 24px circle around it does not overlap other targets.",
      criterion: TARGET_SIZE, severity: "moderate", classification: "bug",
    });
  }

  for (const items of group(occurrences("sticky-obstruction", samples.filter((sample) => sample.profile)), (item) => elementKey(item.issue.element)).values()) {
    const worst = items.reduce((best, item) => (item.issue.coverage ?? 0) > (best.issue.coverage ?? 0) ? item : best, items[0]);
    const coverage = Math.round(worst.issue.coverage ?? 0);
    add("sticky-obstruction", items, {
      worst,
      title: `Fixed bars cover ${coverage}% of the screen at ${worst.sample.width}×${worst.sample.height}`,
      detail: `${worst.issue.detail ?? ""} At high zoom, focused elements can end up hidden behind them.`,
      fixHint: "Make the bar static or collapsible at short viewports (for example @media (max-height: 400px) { position: static }) and add scroll-padding-top equal to its height.",
      criterion: FOCUS_NOT_OBSCURED, severity: coverage >= 50 ? "serious" : "moderate", classification: coverage >= 50 ? "bug" : "review",
    });
  }

  // General accessibility rules from axe-core, grouped per rule and element across the width profiles where axe ran.
  const axeSamples = samples.filter((sample) => sample.axe);
  const axeWidths = axeSamples.map((sample) => sample.width);
  const axeHits = axeSamples.flatMap((sample) => (sample.axe ?? []).flatMap((result) => result.nodes.map((node) => ({ sample, result, node }))));

  for (const [key, items] of group(axeHits, (hit) => `${hit.result.rule}|${hit.node.element ? elementKey(hit.node.element) : hit.node.target}`)) {
    const violations = items.filter((hit) => hit.result.outcome === "violation");
    const chosen = violations.length ? violations : items;
    const narrowest = chosen.reduce((best, hit) => hit.sample.width < best.sample.width ? hit : best, chosen[0]);
    const { result, node } = narrowest;
    const widths = chosen.map((hit) => hit.sample.width);
    const ranges = widthRanges(widths, axeWidths);
    const everywhere = axeWidths.every((width) => widths.includes(width));
    const found = new Set(chosen.map((hit) => hit.sample));
    const label = (sample: AuditSample) => `${sample.profile?.label ?? "Width"} (${sample.width}px)`;
    const missing = axeSamples.flatMap((sample) => found.has(sample) ? [] : [label(sample)]);
    const more = Math.max(...chosen.map((hit) => hit.result.total - hit.result.nodes.length));
    const criterion = axeCriterion(result.tags);
    const severities = chosen.map((hit) => IMPACT_SEVERITY[hit.node.impact ?? hit.result.impact ?? "moderate"]);
    const element = chosen.find((hit) => hit.node.element)?.node.element ?? null;
    const markerList: FindingMarker[] = [];

    for (const hit of chosen) {
      const profileId = hit.sample.profile?.id;

      if (!profileId || !snapshotProfiles.has(profileId) || !hit.node.element || ["html", "body"].includes(hit.node.element.tag) || markerList.some((marker) => marker.profileId === profileId)) continue;
      markerList.push({ profileId, rect: hit.node.element.rect });
    }

    findings.push({
      id: `axe:${result.rule}:${hash(key)}`, kind: "axe",
      title: (everywhere ? result.help : `${result.help} (only at ${formatRanges(ranges)})`).slice(0, 512),
      detail: [
        `${violations.length ? "" : "axe-core could not decide this automatically: "}${node.message.replace(/[\s.]*$/, ".")}`,
        `${element ? "" : `Target: ${node.target}. `}axe-core rule ${result.rule}.`,
        everywhere ? "Found at every profile width." : `Found at ${[...found].map(label).join(", ")}; not at ${missing.join(", ")}.`,
        more > 0 ? `${more} more elements fail this rule (only the first ${AXE_NODE_LIMIT} per profile are listed).` : "",
      ].join(" ").trim(),
      fixHint: axeFix(result.rule, result.help), criterion,
      severity: severities.reduce((worst, severity) => SEVERITY_ORDER[severity] < SEVERITY_ORDER[worst] ? severity : worst, "minor"),
      classification: violations.length && criterion && !result.tags.includes("experimental") ? "bug" : "review",
      element: element && { ...element, selector: element.selector || element.tag },
      ranges, worst: { width: narrowest.sample.width, height: narrowest.sample.height },
      profiles: [...new Set(chosen.flatMap((hit) => hit.sample.profile ? [hit.sample.profile.id] : []))], markers: markerList,
      rule: { id: result.rule, help: result.help, url: isAxeHelpUrl(result.helpUrl) ? result.helpUrl : null },
    });
  }

  // Document-level viewport metadata.
  const first = samples[0]?.measurement;

  if (first?.viewportMeta.zoomBlocked) findings.push({
    id: "zoom-blocked:viewport", kind: "zoom-blocked", title: "Pinch-zoom is disabled by the viewport meta tag",
    detail: `<meta name="viewport" content="${first.viewportMeta.content}"> prevents users from zooming to 200%.`,
    fixHint: "Remove user-scalable=no and any maximum-scale below 2 (ideally remove maximum-scale entirely).",
    criterion: RESIZE_TEXT, severity: "serious", classification: "bug", element: null, ranges: [[narrowest, widest]], worst: { width: narrowest, height: samples[0].height }, profiles: [], markers: [],
  });

  if (first && (!first.viewportMeta.present || !first.viewportMeta.deviceWidth)) findings.push({
    id: "viewport-meta:viewport", kind: "viewport-meta", title: first.viewportMeta.present ? "Viewport meta tag does not use width=device-width" : "Missing viewport meta tag",
    detail: "Phones will lay the page out at about 980px and scale it down, so none of the narrow layouts measured here are what mobile users see.",
    fixHint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the document head.',
    criterion: null, severity: "serious", classification: "bug", element: null, ranges: [[narrowest, widest]], worst: { width: narrowest, height: samples[0].height }, profiles: [], markers: [],
  });

  if (input.interactions) findings.push(...interactionFindings(input.interactions, findings, (kind, element) => `${kind}:${hash(elementKey(element))}`));

  findings.sort((a, b) => CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification] || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.ranges[0]?.[0] ?? 0) - (b.ranges[0]?.[0] ?? 0));
  const ids = new Set(findings.map((finding) => finding.id));
  const interactions = input.interactions;
  const axeAt = new Map(samples.flatMap((sample) => sample.profile && sample.axe ? [[sample.profile.id, sample.axe] as const] : []));

  // A missing finding is resolved only when its check ran again, completely, where it was found; otherwise it is unverified.
  const remeasured = (finding: AuditFinding) => {
    if (finding.kind === "axe") return !!finding.rule && finding.profiles.length > 0 && finding.profiles.every((id) => axeAt.get(id)?.every((item) => item.rule !== finding.rule!.id || item.total <= item.nodes.length));

    if (INTERACTION_KINDS.has(finding.kind)) return !!interactions && !interactions.notes.length && finding.profiles.every((id) => interactions.profiles.includes(id));

    return samples.length > 0;
  };

  // Unverified findings carry forward until they are found again or their check completes (then they are resolved).
  const before = input.previous && input.previous.route === input.route ? [...new Map([...input.previous.unverified ?? [], ...input.previous.findings].map((finding) => [finding.id, finding])).values()] : [];
  const gone = before.filter((finding) => !ids.has(finding.id));
  const resolved = gone.filter(remeasured);
  const unverified = gone.filter((finding) => !remeasured(finding));
  const count = (predicate: (finding: AuditFinding) => boolean) => findings.filter(predicate).length;
  // Interaction snapshots are only kept as boards when a finding marks something on them.
  const markedBoards = new Set(findings.flatMap((finding) => finding.markers.map((marker) => marker.profileId)));
  const profileList = [...new Map(samples.flatMap((sample) => sample.profile ? [[sample.profile.id, { ...sample.profile, issueCount: count((finding) => finding.profiles.includes(sample.profile!.id)) }] as const] : [])).values()];

  return {
    url: input.url, route: input.route, startedAt: input.startedAt, durationMs: input.durationMs, widthsScanned: scanned.length,
    profiles: profileList, snapshots: [...input.snapshots, ...(interactions?.snapshots ?? []).filter((snapshot) => markedBoards.has(snapshot.profileId))], findings, scrollers, resolved, unverified, axe: input.axe,
    summary: {
      bug: count((finding) => finding.classification === "bug"), review: count((finding) => finding.classification === "review"), intentional: count((finding) => finding.classification === "intentional"),
      serious: count((finding) => finding.severity === "serious"), moderate: count((finding) => finding.severity === "moderate"), minor: count((finding) => finding.severity === "minor"),
    },
    interactions: interactions && { durationMs: interactions.durationMs, profiles: interactions.profiles, focusStops: interactions.focusStops, disclosures: interactions.disclosures, hovers: interactions.hovers, notes: interactions.notes },
  };
}
