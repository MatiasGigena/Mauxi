# Real-project acceptance run

The founder nominated Rondo (Vite) and nenazo-nicho (Next.js) as the real projects for [AC-19](alpha-acceptance.md#required-checks). This page describes what the next live run must cover for the responsive audit, how the live runner works today, and the historical record of the 2026-10-15 run. Do not publish project contents, credentials, session bodies or screenshots.

**Status:** the only live run so far (2026-10-15) predates the audit pivot and exercised design tasks. It **does not count toward the restated AC-19**. A new live audit run with founder sign-off is required.

## Next run: responsive audit (AC-19)

### Adapt the runner first

[The live spec](../tests/live-acceptance/real-project.spec.ts) was written for the design tasks. Its plan lists preview selections and a prompt per task (plus a `reducedMotionCheck` flag left over from the animation task). It picks elements, sends the prompt, approves only browser actions and records a Git diff. It never opens the **Responsive audit** panel, runs **Audit site**, uses **Fix with agent**, or saves audit reports. Before the next run, extend it (or perform the missing steps by hand while it records the rest) so the plan and evidence below are covered. Keep its isolated HOME, no-`pi` PATH, approval policy and lifecycle checks.

### Plan

Keep `provider`, `model`, `authFrom`, `evidence` and each project's `name`, `path`, `framework` and `setup`. Each project additionally needs:

- the route for the single-route audit and the start route for **Audit site**, with any pages to uncheck or add by hand;
- the findings to fix, by title or element, or a rule such as "the first three bugs by severity" (at least three, or every bug when there are fewer);
- an optional instruction to send with the attached findings, and a time limit per fix.

### Tasks per project

1. Open the disposable copy in the rebuilt AppImage, confirm the launch plan and select the approved model.
2. Run a single-route audit. Save the report.
3. Run **Audit site** from the start route. Record the listed pages, **Skipped links** and the pages audited. Save the **All pages** summary and each page's report.
4. **Classification review:** a human marks every bug and review item as real, a false positive or misclassified, and checks that deliberate carousels, tables and code blocks appear only under **Intentional scrollers**. Report the false-positive rate (findings judged wrong ÷ findings reported, bugs and review items separately).
5. **Fix with agent:** attach the chosen findings, send, approve only exact browser actions, deny commands unless the plan allows a specific one, and cancel agent questions as before. Record the agent's response and its `responsive_audit` results (at most four per request).
6. **Verify:** re-run the single-route audit and, when a fix touched shared layout, **Audit site**. The fixed findings must be listed under **Resolved since last run**, and no new bug may appear at any width. Use **Show at &lt;width&gt;** on each fixed finding's former worst width to check the live preview.
7. Commit the external Git diff per fix and review it.
8. Close and reopen twice, quit and restart, and check credentials, retained edits, owned processes and integration artifacts, as in the earlier run.

### Evidence

Store everything in the plan's evidence directory, outside Git:

- AppImage SHA-256, runtime versions, OS and external Node/npm versions, and the private usage receipt.
- Per project: the source revision; every audit report as JSON without snapshot image data, like the [audit suites](development.md#integration-checks) write, plus any snapshots the review needs; the site summary and skipped links.
- The classification review: one row per finding with its ID, kind, criterion, classification, widths, human verdict and note, and the false-positive rate.
- Per fix: the attached finding IDs, the agent response, its `responsive_audit` calls and results, approvals, duration, the diff and its SHA-256, and the before/after reports.
- Lifecycle results (cycles, restart, cleanup) and the founder's sign-off with the date.

## How the runner works

`npm run test:live-acceptance` drives the packaged AppImage through [the live spec](../tests/live-acceptance/real-project.spec.ts). It is skipped unless `MAUXI_LIVE_PLAN` names a private plan file listing provider, model, the source `auth.json`, an evidence directory, and per-project paths, selectors and prompts. It never runs in default suites.

For each disposable project copy it currently:

1. Starts the AppImage with an isolated HOME, external Node/npm and no `pi` on PATH; opens the project and confirms launch; selects the model.
2. For each task, picks the declared desktop/mobile elements, optionally hands preview control to the agent, sends the prompt, approves only `Approve browser action` dialogs, denies every other approval and cancels agent questions, then records the response, approvals and an external Git diff committed per task.
3. Closes and reopens twice, quits and restarts the app, and checks credentials, retained edits, owned processes and integration artifacts.

Evidence (report JSON, screenshots, diffs) stays outside Git in the plan's evidence directory.

## 2026-10-15 run (pre-pivot, historical)

This run exercised the design-polish product that was later removed: responsive refinement, component polish and animation tasks with design guidance. It is kept as a record of live authentication, packaging and lifecycle behavior on real projects. It does not count toward the restated AC-19, and its artifact predates the current source.

The founder authorized `openai-codex` / `gpt-6-luna` through the existing ChatGPT OAuth login. AppImage SHA-256 `39d2dd6ac548184271fa00101e84df906a25bb883469d511d36f49ebb2da53ee`. Linux Mint 22.3 / X11 / x86_64, external Node 22.23.1 / npm 10.9.8. Usage over all attempts: 261 model calls, about 0.7M input (plus 10M cached) and 25k output tokens, roughly $0.18 at catalog list price, billed to the ChatGPT subscription rather than per request.

| Project | Responsive refinement | Component polish | Animation / reduced motion | Visible checks + external diff | Human assessment | Auth / spend receipt |
| --- | --- | --- | --- | --- | --- | --- |
| Rondo — React 19, Vite 8.2 | Edited; desktop + mobile captured | Edited; desktop captured, mobile capture hit a reloaded document | CSS stagger edited; existing reduced-motion rule kept; desktop captured, mobile hit a reloaded document | Diffs recorded per task | Not done | Reused OAuth; private receipt |
| nenazo-nicho — React 19, Next 16.3 (default Turbopack dev) | Edited; desktop + mobile inspected and captured | Edited; desktop + mobile inspected and captured | Motion drag edited with a reduced-motion branch; captured both, drag not dispatched | Diffs recorded per task | Not done | Reused OAuth; private receipt |

Both projects completed two close/reopen cycles with both bridges ready, a restart with credentials intact, and final cleanup with no owned processes or integration artifacts. Next rewrites its own `next-env.d.ts` on restart; that file is not a Mauxi artifact.

### Defects found and fixed during the run

- Selections attached before **Give agent control** went stale on send because revalidation replies were dropped while the agent held control.
- `browser_targets` required a workspace ID the model is never given.
- The agent host captured the setup window's browser control and reported "Visible window unavailable" after the workspace window replaced it.
- `workspace_search` failed on a single-file `path`, which also revoked preview control.
- The 16-turn run budget stopped ordinary tasks before verification; the founder approved 40 turns.

Regression coverage: [selection handoff](../tests/browser-e2e/selection-handoff.spec.ts) and the updated [package gate](../tests/package-e2e/private-alpha.spec.ts).

### Known limits observed

- Any failed browser action, including a preview that reloaded after an edit, returns control to the user; the agent must ask for a new handoff.
- Navigation, including in-page anchors, invalidates control by design.
- Browser tools cannot dispatch drags or toggle `prefers-reduced-motion`; motion behavior still needs a human check.
- A budget stop surfaced as "This operation was aborted" instead of naming the budget. Fixed since: chat now names the limit ([run recovery](../tests/browser-e2e/agent-run-recovery.spec.ts)).

When the new audit run is complete and the founder has signed off and recorded tester-delivery approval, update the [acceptance gate](alpha-acceptance.md). Until then the AppImage is a validation candidate. No public release is authorized.
