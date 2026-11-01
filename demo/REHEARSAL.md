# Rehearsal: Mauxi main view

Built with the [Stageshow](../.agents/skills/stageshow/SKILL.md) skill and its kit (vendored in `demo/kit`).
Run it with `npm run demo` (http://127.0.0.1:44180/); rehearse it with `npm run demo:film`.

**Gold:** `linear` (the wide hero: a real product's window at 1:1, inset top and sides, off the bottom,
realistic words on the subject, placeholder bars elsewhere). Kept: the wide-hero layout, one gutter
(20px wide, 12px compact), a `compact` redesign, a caused story with a held payoff. Changed: everything
on screen is Mauxi's own: its tokens (`src/presentation/*.css`), lucide icons, Poppins, the logo asset,
the floating pills, artboard headers, audit panel, finding card, width ruler, marker and chat dock.

**Beats** (plays once, `play="once"`, then holds; the host page has a Replay button):

1. Show at 360px: the live Mobile preview narrows 390 → 360 (the size rolls) and the overflowing
   `div.plan-grid` is outlined with the finding's marker.
2. Fix with agent: the button settles on "Attached to chat", the finding chip drops into the
   composer, its placeholder changes, Send becomes enabled.
3. Send: the exchange opens over the composer, "Working…", the answer streams in.
4. Payoff: the plan cards stack in the preview (the edit landed), the marker clears, then the audit
   re-run lands: Bugs 1 → 0, Resolved 0 → 1, the finding moves to "Resolved since last run". Held.

About 10s to the payoff. A loop was rejected: the only way back to the opening is the bug returning,
which is data rewinding in view, and the chat has no visible undo to cause it.

**Captured:** wide (1080×680) loop, 390 viewport loop (compact 358×640), every marked state at
both, the reduced-motion poster (the payoff). Light theme only (Mauxi has no dark theme).

**Film:** `--gate` ends `rehearsal passed` on the wide loop, the 390 loop and `--states`.
Remaining candidates, judged:
- `steps in its box` / `lands on a transform` on the panel's controls: the finding card collapses
  by height (kit `Collapse`), the buttons scale 0.97 on press; sub-pixel text settling, not visible
  at 1:1.
- `half-pixel glyph` on chip and button icons at odd computed widths: not visible at 1:1.
- `lopsided` on the compact Mobile header: the actions are icon buttons with their own padding,
  as in the app.
- `near-tangent` marker/plan edges (3px): the marker is the app's outline drawn around the element.
- `appears with no entrance` on a `Count` digit strip: the kit's own roll track on first paint.
- Coverage is "inconclusive" from sampling gaps in a headless container; the gate still holds.

**Assumptions:** the storefront project, `/pricing` route, `PlanGrid.tsx:18`, the counts and the
agent's answer are illustrative. Finding titles, criteria, severities, labels, placeholders and the
attach/send behavior come from `audit-report.ts`, `AuditPanel.tsx` and `ChatDock.tsx`.
The canvas is shown without OS chrome: Mauxi is a Linux app and the kit only draws macOS windows.

**Not checked:** a fresh-eye review by a second reviewer; real-device touch; live frame pacing in
a GPU browser (only the virtual clock in headless Chromium).
