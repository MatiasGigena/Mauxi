import { Type, type Static } from "typebox";
import { Check } from "typebox/schema";
import type { AuditElement, FindingCriterion } from "./audit-contract";

const text = (limit: number) => Type.Refine(Type.String(), (value) => value.length <= limit);
const finite = Type.Refine(Type.Number(), (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000);

/**
 * axe-core rules run at every width profile: contrast, text alternatives, names and labels, ARIA validity,
 * landmarks and cheap document checks. Rules that Mauxi measures itself across the width matrix are left out on
 * purpose so one problem never shows up twice: meta-viewport and meta-viewport-large (zoom-blocked),
 * target-size (target-size) and scrollable-region-focusable (scroller-a11y).
 */
export const AXE_RULES: readonly string[] = [
  "color-contrast", "link-in-text-block", "avoid-inline-spacing",
  "image-alt", "input-image-alt", "role-img-alt", "svg-img-alt", "area-alt", "object-alt",
  "button-name", "input-button-name", "link-name", "summary-name", "frame-title",
  "label", "select-name", "aria-input-field-name", "aria-toggle-field-name", "aria-command-name", "aria-meter-name", "aria-progressbar-name", "aria-tooltip-name",
  "aria-allowed-attr", "aria-conditional-attr", "aria-deprecated-role", "aria-hidden-body", "aria-hidden-focus", "aria-prohibited-attr", "aria-required-attr",
  "aria-required-children", "aria-required-parent", "aria-roles", "aria-valid-attr", "aria-valid-attr-value", "nested-interactive",
  "list", "listitem", "document-title", "html-has-lang", "html-lang-valid",
  "region", "landmark-one-main", "landmark-unique",
];

/**
 * Inconclusive color-contrast reasons that are dropped: they come from fixed bars overlapping text at the measured
 * scroll position (reported by Mauxi as 2.4.11), offscreen content, icon glyphs, or text styled to match its background.
 */
export const AXE_IGNORED_INCOMPLETE: readonly string[] = ["bgOverlap", "elmPartiallyObscured", "elmPartiallyObscuring", "outsideViewport", "shortTextContent", "nonBmp", "equalRatio"];

export const AXE_NODE_LIMIT = 8;

/** Rule results kept per profile; the rules past it are listed in AxeRun.overLimit. */
export const AXE_RESULT_LIMIT = 64;

export const AXE_TIMEOUT_MS = 10_000;

export interface AxeRunOptions { rules: readonly string[]; maxNodes: number; maxResults: number; timeoutMs: number; ignoredIncomplete: readonly string[] }

const ImpactSchema = Type.Union([Type.Null(), Type.Literal("critical"), Type.Literal("serious"), Type.Literal("moderate"), Type.Literal("minor")]);

const AxeNodeSchema = Type.Object({ target: text(1_024), message: text(600), impact: ImpactSchema });

const AxeRuleResultSchema = Type.Object({
  rule: text(64),
  outcome: Type.Union([Type.Literal("violation"), Type.Literal("incomplete")]),
  impact: ImpactSchema,
  tags: Type.Array(text(64), { maxItems: 32 }),
  help: text(512),
  helpUrl: text(512),
  total: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  nodes: Type.Array(AxeNodeSchema, { maxItems: AXE_NODE_LIMIT }),
});

export const AxeRunSchema = Type.Object({
  version: text(32), durationMs: finite, results: Type.Array(AxeRuleResultSchema, { maxItems: AXE_RESULT_LIMIT }),
  /** Rules whose inconclusive nodes were left out (AXE_IGNORED_INCOMPLETE); those elements are undecided, not passing. */
  ignored: Type.Array(text(64), { maxItems: 64 }),
  /** Rules with results past maxResults, left out of results; their elements are unknown at this profile. */
  overLimit: Type.Array(text(64), { maxItems: 64 }),
});

export type AxeRun = Static<typeof AxeRunSchema>;

export type AxeRuleResult = Static<typeof AxeRuleResultSchema>;

export type AxeImpact = Static<typeof ImpactSchema>;

export function isAxeRun(value: unknown): value is AxeRun {
  return Check(AxeRunSchema, value);
}

/** One axe result at one profile, with its nodes resolved to Mauxi elements in the page's main world. */
export interface AxeProfileResult extends Omit<AxeRuleResult, "nodes"> {
  nodes: Array<{ target: string; message: string; impact: AxeImpact; element: AuditElement | null }>;
}

const CRITERIA = new Map([
  ["1.1.1", "Non-text Content"], ["1.3.1", "Info and Relationships"], ["1.4.1", "Use of Color"], ["1.4.3", "Contrast (Minimum)"], ["1.4.12", "Text Spacing"],
  ["2.1.1", "Keyboard"], ["2.4.1", "Bypass Blocks"], ["2.4.2", "Page Titled"], ["2.4.4", "Link Purpose (In Context)"], ["3.1.1", "Language of Page"], ["4.1.2", "Name, Role, Value"],
]);

/** The first WCAG success criterion in axe tags (wcag143 → 1.4.3); best-practice rules have none. */
export function axeCriterion(tags: readonly string[]): FindingCriterion | null {
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);

    if (match) {
      const id = `${match[1]}.${match[2]}.${match[3]}`;

      return { id, name: CRITERIA.get(id) ?? "Success Criterion" };
    }
  }

  return null;
}

const FIXES: Array<[RegExp, string]> = [
  [/^color-contrast$/, "Raise the text/background contrast to at least 4.5:1 (3:1 for large text). Check the media queries that change color, background or font size in this width range."],
  [/^link-in-text-block$/, "Distinguish links in running text by more than color (underline, or 3:1 contrast with the surrounding text plus a focus/hover cue)."],
  [/-alt$/, "Add alt text that conveys the image's purpose, or alt=\"\" (role=\"presentation\") when it is decorative."],
  [/^(?:button-name|input-button-name|link-name|summary-name|aria-command-name)$/, "Give the control an accessible name: visible text, aria-label or aria-labelledby. Icon-only controls that only appear in some layouts (menu toggles, collapsed toolbars) need one too."],
  [/^(?:label|select-name|aria-input-field-name|aria-toggle-field-name)$/, "Associate a visible <label> (or aria-label/aria-labelledby) with the field in every layout; a placeholder alone is not a label."],
  [/^aria-hidden-focus$/, "Hidden off-canvas or collapsed content must not stay focusable: add inert (or tabindex=\"-1\" on its controls) in the layouts where it is hidden."],
  [/^(?:region|landmark-)/, "Keep the content inside landmarks (header, nav, main, footer) in every layout; mobile-only wrappers and portals often end up outside them."],
  [/^nested-interactive$/, "Do not nest focusable controls inside another control (for example a button inside a link card); move one of them out."],
  [/^frame-title$/, "Give the iframe a title that describes its content."],
];

export function axeFix(rule: string, help: string): string {
  return FIXES.find(([pattern]) => pattern.test(rule))?.[1] ?? `${help}.`;
}

/** Only links to Deque's rule documentation are opened outside Mauxi. */
export function isAxeHelpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && url.hostname === "dequeuniversity.com" && url.pathname.startsWith("/rules/axe/") && !url.username && !url.password && !url.port;
  } catch { return false; }
}
