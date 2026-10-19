# Responsive accessibility audit

Mauxi measures how a page of your local project behaves across a matrix of viewport widths and zoom levels, classifies what it finds, and lets you or the agent fix it in the real source and re-check it.

## Run an audit

Open **Responsive audit** at the top right and choose **Run audit**. Mauxi audits the route currently open in the Desktop preview. It loads that route in a hidden offscreen window that shares the workspace's browser session (so cookies and local storage match your previews) and never resizes or reloads the visible previews.

The scan takes about ten to fifteen seconds:

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

3. **Interaction pass** at 400% zoom and Small phone: a Tab-only keyboard focus walk, closed menus and disclosures opened one at a time, and tooltips hovered (see [Interaction pass](#interaction-pass)). It adds about two to four seconds.

Animations and transitions are paused and `prefers-reduced-motion: reduce` is emulated, so layouts settle between widths. Viewports use desktop zoom semantics (no mobile `<meta viewport>` scaling), which matches what WCAG 1.4.10 measures.

## Audit several pages

Choose **Audit site** (the stacked-layers button beside **Run audit**) to audit more than the current route. Mauxi first finds the project's pages, then shows them as a checklist before anything is measured:

1. **Discovery** loads the Desktop preview's route in the same hidden window and reads every `a[href]` and `area[href]`. It then opens each page it found (one level deeper) and reads their links too. At most 12 pages are listed, in the order they were found, with the starting route first.
2. **Choose pages.** Every listed page is checked. Uncheck pages, or type a route and choose **Add**. Hand-added routes go through the same policy as discovered ones. **Skipped links** lists same-origin links that were left out and why.
3. **Audit N pages** runs the normal single-route audit on each page, one after another, including the interaction pass (about two to four seconds more per page, so a 12-page batch takes roughly two to three minutes). Keeping it means a page's counts in the batch match a single run of that page. Progress shows the page (for example *Page 2 of 3*) and that page's sweep. **Stop** ends the current page and skips the rest; pages already audited keep their results.

The **All pages** summary lists every page with its bug, review and intentional counts, a ruler of the widths where bugs were measured, and the widest failing ranges. Click a page to open its findings and snapshots in the usual panel and canvas; **All pages** returns to the summary. **Re-run** on an open page re-audits that page and updates its row. Running **Audit site** again compares each page with its previous run, so resolved findings are listed per page.

### What discovery leaves out, and why

Discovery only follows links a visitor could open with a plain GET, and only on the approved project origin. Each guard maps to a failure it prevents:

| Link | Handling | Failure it prevents |
| --- | --- | --- |
| Other origins, protocol-relative `//host`, `mailto:`, `tel:`, `javascript:`, `data:`, `blob:` | Ignored and only counted | Auditing someone else's site or running script URLs |
| Authentication, API, action and callback paths (`/api/…`, `/auth/…`, `logout`, `callback`, `checkout`, `delete`, `unsubscribe`, …) and sensitive query keys (`token`, `code`, `state`, …) | Skipped with a reason; the same policy as [route linking](workspace.md#routes) | Signing the user out, consuming one-time codes or triggering actions just by loading a URL |
| Links with a `download` attribute | Skipped | Writing files instead of rendering a page |
| Files that are not pages (`.pdf`, `.zip`, images, `.json`, `.xml`, `.txt`, `.csv`, …) | Skipped | Measuring a file viewer, or downloading |
| Dev-server internals (`/@vite/…`, `/@fs/…`, `/node_modules/…`, `/_next/…`, `/__…`) | Skipped | Auditing tooling endpoints |
| Same-page anchors and hash variants (`#beans`, `/about#team`) | Hash dropped, then de-duplicated | Auditing one document several times |
| Bridge parameters (`mauxiSession`, …) and repeated links | Removed, then de-duplicated | Duplicate pages |
| Forms, buttons and script-driven navigation | Never followed | Non-GET requests and side effects |
| A page that redirects to a skipped or external route while discovering | Removed with a reason | Following a redirect into a login or callback flow |
| Endless link sets (calendars, pagination) | At most 12 pages, 400 links read per page, two levels, 10 s per page and 45 s in total | Discovery that never ends |
| `window.open`, `beforeunload` prompts | Denied and ignored | A page holding the hidden window hostage |
| A page that fails to load while discovering | Its links are not read; discovery continues (only a failing start page fails discovery) | One broken page hiding the rest |

### Batch failure modes

- **A page fails** (load error, time limit, navigation outside the origin): that row is marked failed with the error and the batch continues with the next page.
- **Stop or closing the workspace** aborts the current page and marks the remaining pages skipped. Pages already measured keep their results.
- **Overlapping runs:** only one audit, discovery or batch runs at a time; starting another is refused until it finishes or is stopped.
- **Memory:** only page summaries are sent to the panel while the batch runs. Full reports stay in the main process, at most 16 (the oldest are dropped), and batch snapshots are captured at half resolution, so a 12-page batch keeps roughly a quarter of the image data of 12 single runs. A page's report is loaded into the panel only when you open it. If it was dropped, run that page again.
- **Stale results:** the summary belongs to the workspace and is cleared when the workspace closes. Re-running one page updates its row.

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
| Fixed bars cover the screen | 2.4.11 Focus Not Obscured (Minimum) | Fixed or sticky bars anchored to the top and bottom cover more than 40% of a profile's viewport, typically at 400% zoom. Measured at the top of the page; the keyboard focus walk below measures what focus actually hits. |
| Pinch-zoom disabled | 1.4.4 Resize Text | The viewport meta tag sets `user-scalable=no` or `maximum-scale` below 2. |
| Missing viewport meta | — | No `width=device-width`, so phones lay the page out at about 980 px. |
| General accessibility rules | From axe-core tags (for example 1.4.3, 1.1.1, 4.1.2) | axe-core at the phone, tablet, laptop and desktop profiles. See [General accessibility checks](#general-accessibility-checks-axe-core). |

### Intentional scrollers versus bugs

Deliberate horizontal scrolling (carousels, logo rails, data tables, code blocks) is never reported as a reflow bug. A scroller counts as intentional when it has any of these signals: `scroll-snap-type` on the x axis, `aria-roledescription` mentioning carousel or slide, an ARIA role such as `region`, `tablist`, `listbox`, `toolbar` or `marquee`, class/id/data-attribute names such as `carousel`, `slider`, `swiper`, `embla`, `splide`, `rail` or `track`, a `pre`/`code` block or a `table` inside, previous/next buttons beside it, or uniformly sized items in an `overflow-x: auto` container. A scroller that still scrolls at 1440 px or wider is also treated as intentional. Intentional scrollers appear in their own list and are only flagged when they are not reachable by keyboard.

Anything ambiguous is classified **Needs review** rather than **Bug**. Choose **Mark intentional** to hide a review or intentional finding for this workspace; it moves to **Marked intentional** and can be restored.

### Deliberate negatives

These patterns are measured and stay silent: off-canvas drawers translated outside the viewport (fixed position or `aria-hidden`), visually hidden helper text (1×1 px or clipped), fixed elements outside the viewport, and intentional scrollers that are reachable by keyboard.

## Interaction pass

After the width sweep and the profiles, Mauxi checks what a keyboard or pointer user reaches, at **Small phone** (320 × 568) and **400% zoom** (320 × 256). It runs after every snapshot is captured, so it never changes what the other checks measured.

| Finding | Criterion | How it is measured |
| --- | --- | --- |
| Keyboard focus hidden behind a fixed bar | 2.4.11 Focus Not Obscured (Minimum) | Mauxi presses Tab (CDP key events) from the start of the page and, at each focus stop, hit-tests a grid of points over the focused element. Points whose topmost element belongs to a visible fixed or sticky bar count as covered. Entirely covered is a **bug**; partly covered is **review**. One finding per covering bar lists the hidden stops. When the page already has a *Fixed bars cover the screen* finding, the evidence for every bar is added to that finding instead (one root cause, one finding). This also catches what the coverage check misses, such as a sticky header that sits below a banner at the top of the page. |
| No visible focus indicator | 2.4.7 Focus Visible (review) | Compares the computed outline, box shadow, border, background, text decoration, color, opacity and transform of the focused element, its `::before`/`::after` and up to three ancestors with the same values captured before any element had focus. No change at all is reported for review; a change limited to color, text decoration, weight, opacity or transform is reported as subtle. A focus stop outside the viewport (for example a link inside a hidden drawer) is reported here too. |
| Opened menu overflows or is cut off | 1.4.10 Reflow | Opens closed disclosures (`button[aria-expanded="false"]` with `aria-controls`, `<details>`, `button[aria-haspopup]`) with a CDP click, then measures the revealed content: wider than the viewport or past its edge, page scroll width growing, fixed content running past the bottom without a scroll area that ends inside the viewport, or content clipped by an `overflow: hidden` ancestor. |
| Hover content clipped or not hoverable | 1.4.13 Content on Hover or Focus | At 320 × 568, hovers elements whose `aria-describedby` points at a hidden tooltip (or that contain a hidden `role="tooltip"`), then checks whether the revealed content is cut off by the viewport (**bug**) and whether it stays visible when the pointer moves onto it (**review**). |

Snapshots of the moment are added as extra boards (for example **Focus · 400% zoom** at the scroll position where a focused link sat under the header, **Menu open** and **Hover**), only for findings the interaction pass reports on its own; evidence added to a coverage finding stays in its text. Each board's markers use the viewport position captured with the screenshot. The panel's **Interaction checks** section shows the number of focus stops, disclosures and tooltips, the time the pass took and every note.

### Bounds and side-effect policy

- At most 40 focus stops per profile; the walk stops when focus returns to a visited element, leaves the document (body, an iframe or a closed shadow root) or the 20-second interaction budget runs out.
- Only Tab is pressed during the focus walk: never Enter, Space or text. Focus starts from a temporary, invisible marker at the top of `<body>`, and is blurred and the page scrolled back to the top afterwards.
- At most 6 disclosures per profile and 6 hover targets. Only `button` and `summary` elements are clicked. Skipped, with a note: links and `role="button"` links, submit buttons that belong to a form, buttons with `formaction`, buttons inside links, inline `onclick` or React click handlers that mention navigation (`location`, `navigate`, `router`, `href`, `submit`, `window.open`), and buttons whose name reads like a destructive or payment action (delete, remove, buy, pay, sign out, send).
- While interacting, every navigation of the audit window is blocked. A trigger that still changes the URL (for example `pushState`) is noted, history is restored, and the rest of the disclosure pass is skipped.
- Each opened disclosure is closed by clicking its trigger again (or Escape when the trigger is covered by its own menu) and Mauxi verifies that `aria-expanded`/`open`, the URL and the scroll position are back to their initial values. If not, the remaining interactions are skipped with a note.
- Interaction failures never fail the audit: the report lists what was skipped and why under **Interaction checks** in the panel.

### How the interaction pass can fail

- **Focus does not move:** offscreen windows have no OS focus. CDP key events still move focus (no focus emulation is needed); if no element receives focus, the report notes it instead of reporting a clean result.
- **Endless or trapped focus:** roving tab indexes, focus traps and generated content are cut off by the stop limit, cycle detection and the time budget.
- **Wrong start:** a previous walk leaves the sequential focus starting point mid-page; every walk starts from the marker at the top of `<body>`.
- **Page reactions to Tab:** keydown and focus handlers run as they would for a user (for example a menu opening on focus). The measurement already captured is not affected, and the page is restored afterwards.
- **Hit-testing blind spots:** overlays with `pointer-events: none` are invisible to hit-testing, so they never count as covering (possible miss). Transparent fixed wrappers count only when the hit element or one of its fixed ancestors paints a background, border, text or media (avoids false positives).
- **Focus indicators drawn elsewhere:** focus-ring libraries, sibling elements or JavaScript overlays can draw a ring Mauxi does not compare, so *No visible focus indicator* is always **review**. Contrast of the indicator (2.4.13) is not measured.
- **Triggers that navigate or act:** handled by the skip list and the navigation block above. Handlers attached with `addEventListener` cannot be inspected, so a plain-looking `button` that performs an action when clicked is still clicked once; the action stays inside the page and any navigation is blocked.
- **Triggers covered or off-screen:** each trigger is scrolled to the middle of the viewport or, when a bar covers it there, to the first position where hit-testing reaches it; a trigger covered everywhere is skipped and noted.
- **Content that cannot be found:** without `aria-controls`, the revealed content is the trigger's next sibling (or the `<details>` body). A trigger that reveals nothing measurable is noted, not reported.
- **Late layout:** transitions are disabled; Mauxi waits one animation frame after each Tab and two frames plus 120 ms after each click or hover. Menus positioned by slow scripts can be measured early.
- **State not restored:** handled by the verification above; when it fails the pass stops so no later check measures a modified page.
- **Hover content:** only tooltips with `role="tooltip"` or `aria-describedby` semantics are found, and only content that appears within 120 ms. Escape-to-dismiss (the third 1.4.13 requirement) is not pressed.

## General accessibility checks (axe-core)

At the Small phone, Phone, Tablet, Laptop and Desktop profiles, Mauxi also runs [axe-core](https://github.com/dequelabs/axe-core) 4.13 on the same loaded page, before the interaction pass, so focus, opened menus or hover never affect its results. Running the same rules in every layout finds problems that exist in one layout only: an icon-only menu toggle without a name that is shown only below 600 px, text whose color drops below 4.5:1 in a mobile media query, or an icon link that only appears on desktop.

- **Rules:** color contrast and links distinguished only by color; text alternatives (`img`, image inputs, `role="img"`, `svg`, `area`, `object`); names of buttons, links, `summary`, frames and ARIA widgets; form labels; ARIA attribute, role and parent/child validity, `aria-hidden` containers with focusable content, nested interactive controls; lists; page title and language; landmarks (`region`, one `main`, unique landmarks); inline text-spacing styles. The full list is `AXE_RULES` in `src/application/audit-axe.ts`.
- **Not repeated:** axe's `meta-viewport`, `meta-viewport-large`, `target-size` and `scrollable-region-focusable` rules are skipped, because Mauxi measures pinch-zoom, target size and scroller keyboard access itself across the width sweep.
- **Classification:** a violation of a rule tagged with a WCAG success criterion is a **Bug** with that criterion (`wcag143` → 1.4.3). Best-practice rules (landmarks), experimental rules and results axe could not decide (for example text on a gradient or a background image) are **Needs review**. Severity follows axe's impact: critical and serious are serious.
- **Width ranges:** results are grouped per rule and element across the profiles. A finding measured at 320 and 390 px but not at 768 px reads "(only at 320–390px)" and lists the profiles where it passes. A profile where axe could not decide for that element (for example the same text on a gradient in the wide layout) is listed as inconclusive, never as passing. The ranges are bounded by the profile widths (320, 390, 768, 1280, 1440); the exact breakpoint between two profiles is not swept.
- **Elements and sources:** axe's selectors are resolved in the page and described like every other finding (selector, `data-testid`, React source hint, host verification), so snapshot markers, **Show at &lt;width&gt;** and **Fix with agent** work the same way. Cards show the rule id (for example `axe · button-name`). At most 8 elements per rule and profile are listed; the finding says how many more failed.
- **Dropped inconclusive results:** contrast results that axe cannot decide because a fixed bar overlaps the text at the measured scroll position (Mauxi reports such bars as 2.4.11), because the element is offscreen, or because the content is a single glyph or icon are not reported.
- **Isolation:** axe-core runs in an isolated JavaScript world created over the DevTools protocol. Page scripts cannot override it, it defines no globals in the page, and a page that already ships axe-core is unaffected. Its results are validated and size-bounded before they reach the report.
- **Cost and failures:** axe adds roughly 0.2–1 s to an audit on the lab pages; the report records its time. If axe cannot be injected, takes longer than 10 s at a profile or returns an unexpected result, the layout audit still completes and the panel shows a note.
- **Learn more** opens Deque's rule page in your default browser. Only `https://dequeuniversity.com/rules/axe/…` links that appear in a stored report can be opened.

axe-core is © Deque Systems, Inc. and licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/). Mauxi bundles its unmodified `axe.min.js` into the desktop host; its source is available from the axe-core project.

## Panel, snapshots and live highlight

The panel shows a 320–1920 px ruler of the widths where bugs were measured, counts per classification, and the findings. Each finding has its own ruler, the WCAG criterion, the element selector, the source location, what was measured and a fix direction.

- Source locations marked with a check are **host-verified**: the element has a unique literal `data-testid` found in one project file. Otherwise the file and component name are an unverified hint from the React development build.
- Snapshots of every profile appear below the live previews with numbered markers. Click a marker to select its finding.
- **Show at &lt;width&gt;** resizes the closest live preview (Mobile at 1024 px or less, Desktop otherwise) to the worst width and outlines the element in the live page for eight seconds. It is refused while the agent holds browser control.
- **Re-run** compares with the previous report for the same route and lists what was **Resolved since last run**.

## Fix with the agent

**Fix with agent** attaches the finding to the chat. Send it alone to use the default instruction, or add your own. The request carries a compact description of each finding: criterion, width ranges, element, source, measurement and fix direction. Snapshots and geometry are not sent.

The agent has a `responsive_audit` tool that re-runs the same audit for a route (by default the route last audited or opened, or `/`), at most four times per request. See [agent tools](agent.md#responsive_audit) for its parameters and results. Every run, including the agent's, updates the panel; attachments that a newer run no longer reports are removed from the chat. The agent is told to prefer fluid fixes that hold across the whole width range, to keep intentional scrollers scrolling, and to confirm its fix with `responsive_audit`. Passing `routes` (up to 12) instead of `route` runs a site audit in one call that counts as one of the four; it returns per-page counts and bug widths, and refuses authentication, API, action and callback routes like the panel does. The panel then shows the **All pages** summary. The agent is told to use it when a fix touches layout shared by several pages.

## How it can fail

The detector was designed against these failure modes; each is either handled or documented as a limit.

- **False positives:** off-canvas drawers, sr-only text, decorative elements behind `overflow-x: hidden`, intentional scrollers and the scrollbar-width overflow of `100vw` boxes. These are handled as described above. A scroller with none of the listed signals that scrolls only at narrow widths is reported for review, never as a bug.
- **Missed overflow:** elements inside `position: fixed` containers, in cross-origin iframes or in closed shadow roots are not measured. Pages larger than 6,000 rendered elements are truncated and the measurement says so; a measurement lists at most 160 issues. A previous finding that is missing from a truncated measurement, or one at the issue limit, at a width where it was found stays **Not re-checked this run** instead of resolved.
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
- A single run audits the route in the Desktop preview; **Audit site** covers at most 12 linked pages. Layout checks measure the state a page loads in; the interaction pass adds keyboard focus, closed disclosures and tooltips at two narrow profiles only. Forms are never filled, nothing is typed, and states behind clicks on links, tabs, carousels or comboboxes are not explored. Pages reachable only through script navigation or forms are not discovered (add them by hand), and hash-router routes such as `/#/about` collapse into one page because the hash is dropped.
- Text resize (1.4.4) is covered through zoom-equivalent widths and the viewport meta check, not browser text-only zoom.
- Orientation (1.3.4) is not checked automatically.
- axe-core checks the top document only: iframes are not checked, and elements inside shadow roots are reported by their axe selector without an element, source or marker.
- axe-core does not run at the text-spacing and 400% zoom profiles, which repeat the 320 and 1280 px layouts.
- Snapshots are captured up to 2,400 px tall; markers below that are listed in the panel only.
