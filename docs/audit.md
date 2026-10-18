# Responsive accessibility audit

Mauxi measures how a page of your local project behaves across a matrix of viewport widths and zoom levels, classifies what it finds, and lets you or the agent fix it in the real source and re-check it.

## Run an audit

Open **Responsive audit** at the top right and choose **Run audit**. Mauxi audits the route currently open in the Desktop preview. It loads that route in a hidden offscreen window that shares the workspace's browser session (so cookies and local storage match your previews) and never resizes or reloads the visible previews.

The scan takes about ten seconds:

1. **Width sweep:** every 16 CSS px from 320 to 1440, plus 1600 and 1920, at 900 px tall. The sweep finds problems that only appear between breakpoints.
2. **Profiles**, measured with every check and captured as snapshots:

| Profile | Viewport | Why |
| --- | --- | --- |
| Small phone | 320 × 568 | WCAG 1.4.10 reflow width |
| Phone | 390 × 844 | Common phone |
| Tablet | 768 × 1024 | Common breakpoint |
| Laptop | 1280 × 800 | Common breakpoint |
| Desktop | 1440 × 900 | Wide layout |
| 400% zoom | 320 × 256 | A 1280 × 1024 screen at 400% zoom |
| Text spacing | 320 × 568 and 1280 × 800 | WCAG 1.4.12 overrides: line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em |

Animations and transitions are paused and `prefers-reduced-motion: reduce` is emulated, so layouts settle between widths. Viewports use desktop zoom semantics (no mobile `<meta viewport>` scaling), which matches what WCAG 1.4.10 measures.

## What it checks

| Finding | Criterion | How it is measured |
| --- | --- | --- |
| Horizontal scroll | 1.4.10 Reflow (at 320 px) | The document scrolls horizontally. Mauxi reports the outermost box that extends past the viewport, the grid/flex container whose tracks are wider than itself, or the text box holding an unbreakable string. If the overflow equals the scrollbar width, it points at `100vw` or a viewport-sized `min-width`. Overflow only between breakpoints (for example 800–960 px) is reported as a breakpoint gap without a WCAG criterion. |
| Content cut off by overflow-x: hidden | 1.4.10 | `html` or `body` hides horizontal overflow and a visible box with content extends past the edge. |
| Container scrolls horizontally | 1.4.10 (review) | An inner scroller with no carousel, table or code signals that only scrolls at narrower widths. |
| Intentional scroller not keyboard accessible | 2.1.1 Keyboard | A deliberate scroller has no `tabindex="0"` and no focusable children, or uses `role="region"` without a name. |
| Content hidden by overflow | 1.4.10 (review) | A container clips content at narrow widths but fits at the widest width. |
| Text cut off / truncated | 1.4.10 | A text container with `overflow` hidden/clip no longer fits at narrow profiles but fits at desktop. Ellipsis and line clamps are reported as truncation for review. |
| Text clipped with increased spacing | 1.4.12 Text Spacing | Text clips only after the spacing overrides, compared with the same width without them. |
| Touch target smaller than 24×24 | 2.5.8 Target Size (Minimum) | An interactive element under 24×24 CSS px sits within the 24 px spacing circle of another target. Inline links in sentences and labelled checkboxes/radios are exempt. |
| Fixed bars cover the screen | 2.4.11 Focus Not Obscured (Minimum) | Fixed or sticky bars anchored to the top and bottom cover more than 40% of a profile's viewport, typically at 400% zoom. |
| Pinch-zoom disabled | 1.4.4 Resize Text | The viewport meta tag sets `user-scalable=no` or `maximum-scale` below 2. |
| Missing viewport meta | — | No `width=device-width`, so phones lay the page out at about 980 px. |

### Intentional scrollers versus bugs

Deliberate horizontal scrolling (carousels, logo rails, data tables, code blocks) is never reported as a reflow bug. A scroller counts as intentional when it has any of these signals: `scroll-snap-type` on the x axis, `aria-roledescription` mentioning carousel or slide, an ARIA role such as `region`, `tablist`, `listbox`, `toolbar` or `marquee`, class/id/data-attribute names such as `carousel`, `slider`, `swiper`, `embla`, `splide`, `rail` or `track`, a `pre`/`code` block or a `table` inside, previous/next buttons beside it, or uniformly sized items in an `overflow-x: auto` container. A scroller that still scrolls at 1440 px or wider is also treated as intentional. Intentional scrollers appear in their own list and are only flagged when they are not reachable by keyboard.

Anything ambiguous is classified **Needs review** rather than **Bug**. Choose **Mark intentional** to hide a review or intentional finding for this workspace; it moves to **Marked intentional** and can be restored.

### Deliberate negatives

These patterns are measured and stay silent: off-canvas drawers translated outside the viewport (fixed position or `aria-hidden`), visually hidden helper text (1×1 px or clipped), fixed elements outside the viewport, and intentional scrollers that are reachable by keyboard.

## Panel, snapshots and live highlight

The panel shows a 320–1920 px ruler of the widths where bugs were measured, counts per classification, and the findings. Each finding has its own ruler, the WCAG criterion, the element selector, the source location, what was measured and a fix direction.

- Source locations marked with a check are **host-verified**: the element has a unique literal `data-testid` found in one project file. Otherwise the file and component name are an unverified hint from the React development build.
- Snapshots of every profile appear below the live previews with numbered markers. Click a marker to select its finding.
- **Show at <width>** resizes the closest live preview (Mobile at 1024 px or less, Desktop otherwise) to the worst width and outlines the element in the live page for eight seconds.
- **Re-run** compares with the previous report for the same route and lists what was **Resolved since last run**.

## Fix with the agent

**Fix with agent** attaches the finding to the chat. Send it alone to use the default instruction, or add your own. The request carries a compact description of each finding: criterion, width ranges, element, source, measurement and fix direction. Snapshots and geometry are not sent.

The agent has a `responsive_audit` tool that re-runs the same audit for a route, at most four times per request. Every run, including the agent's, updates the panel; attachments that a newer run no longer reports are removed from the chat. The agent is told to prefer fluid fixes that hold across the whole width range, to keep intentional scrollers scrolling, and to confirm its fix with `responsive_audit`.

## How it can fail

The detector was designed against these failure modes; each is either handled or documented as a limit.

- **False positives:** off-canvas drawers, sr-only text, decorative elements behind `overflow-x: hidden`, intentional scrollers and the scrollbar-width overflow of `100vw` boxes. These are handled as described above. A scroller with none of the listed signals that scrolls only at narrow widths is reported for review, never as a bug.
- **Missed overflow:** elements inside `position: fixed` containers, in cross-origin iframes or in closed shadow roots are not measured. Pages larger than 6,000 rendered elements are truncated and the measurement says so.
- **Unsettled layouts:** each width waits 60 ms (250 ms for profiles) after resizing. Layouts driven by slow JavaScript (debounced resize handlers, lazy content) can be measured mid-update. A dev server full reload during the scan fails the audit; run it again.
- **Wrong element:** when several siblings overflow together the container is reported. A deeply nested cause behind a fixed-width ancestor is reported at the ancestor, unless it reaches further than that ancestor (for example a fixed-width row inside a `body` that only overflows by the scrollbar): then both are reported.
- **Unverified source:** stack-derived hints refer to transformed development code, so only the file is kept and line numbers are omitted unless the `data-testid` match verifies them.
- **Page side effects:** loading the route issues the same requests as opening it in a preview, including requests to any backend the page calls. Use development accounts.
- **Navigation:** redirects and navigations outside the project origin are blocked and fail the audit.

## Next.js

Audits work on `next dev` with Webpack or Turbopack. The end-to-end suites exercise an App Router route with both bundlers; the Pages Router is handled by the same hydration wait but not covered by a fixture.

- **Hydration:** Next hydrates after the load event. The hidden window waits up to 10 seconds for hydration (the App Router `body`, or the first child of the Pages Router `#__next`, has a React fiber) before measuring, so client components and their effects are in place and source hints are available.
- **Source hints:** the component is the one that wrote the JSX, Server Components included (for example `RootLayout` or the page component), never Next's internal wrappers. With Webpack the file is the project file for client and Server Components (`app/...`). Turbopack stacks only point at hashed chunks (`_next/static/chunks/...` and `.next/dev/server/chunks/...`), so its hints carry the component without a file. Host verification through a unique literal `data-testid` works the same with both bundlers.
- **Dev tools:** Next renders its dev indicator and error overlay inside the shadow root of a `nextjs-portal` element (hosted in a `<script data-nextjs-dev-overlay>` element on the App Router), and the route announcer in another shadow root. Shadow roots and script elements are not measured, so they never create findings. An open error overlay is not measured either, so fix runtime errors before auditing.
- **Viewport:** Next writes the viewport meta tag from `export const viewport` (default `width=device-width, initial-scale=1`). `maximumScale` below 2 or `userScalable: false` is reported as pinch-zoom disabled; a route-level export only affects that route.
- **Streaming:** the scan starts once the document finished loading, which for a streamed route is when the server closes the stream after its last Suspense boundary. Content that suspends again on the client after hydration can be measured in its fallback state.
- **Hot reload:** the hidden window connects to the dev server like any tab. CSS and Fast Refresh updates during a scan apply in place and may be measured mid-update; a full reload fails the audit.

## Limits

- Automated checks cover only part of WCAG. A clean audit is not a conformance claim.
- Only the route in the Desktop preview is audited per run, in the state it loads in (no interactions, no hover or open menus).
- Text resize (1.4.4) is covered through zoom-equivalent widths and the viewport meta check, not browser text-only zoom.
- Orientation (1.3.4) is not checked automatically.
- Snapshots are captured up to 2,400 px tall; markers below that are listed in the panel only.
