# Real-project acceptance run

[AC-19](acceptance.md#required-checks) needs a live run on two real projects, one Vite and one Next.js, chosen by the maintainer. This page describes what that run must cover and how the live runner works. Do not publish project contents, credentials, session bodies or screenshots.

**Status:** no live audit run has been done yet.

## Responsive audit run (AC-19)

### Adapt the runner first

[The live spec](../tests/live-acceptance/real-project.spec.ts) predates the audit. Its plan lists preview selections and a prompt per task (plus an unused `reducedMotionCheck` flag). It picks elements, sends the prompt, approves only browser actions and records a Git diff. It never opens the **Responsive audit** panel, runs **Audit site**, uses **Fix with agent**, or saves audit reports. Before the run, extend it (or perform the missing steps by hand while it records the rest) so the plan and evidence below are covered. Keep its isolated HOME, no-`pi` PATH, approval policy and lifecycle checks.

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
8. Close and reopen twice, quit and restart, and check credentials, retained edits, owned processes and integration artifacts.

### Evidence

Store everything in the plan's evidence directory, outside Git:

- AppImage SHA-256, runtime versions, OS and external Node/npm versions, and the provider usage for the run.
- Per project: the source revision; every audit report as JSON without snapshot image data, like the [audit suites](development.md#integration-checks) write, plus any snapshots the review needs; the site summary and skipped links.
- The classification review: one row per finding with its ID, kind, criterion, classification, widths, human verdict and note, and the false-positive rate.
- Per fix: the attached finding IDs, the agent response, its `responsive_audit` calls and results, approvals, duration, the diff and its SHA-256, and the before/after reports.
- Lifecycle results (cycles, restart, cleanup) and the maintainer's sign-off with the date.

## How the runner works

`npm run test:live-acceptance` drives the packaged AppImage through [the live spec](../tests/live-acceptance/real-project.spec.ts). It is skipped unless `MAUXI_LIVE_PLAN` names a private plan file listing provider, model, the source `auth.json`, an evidence directory, and per-project paths, selectors and prompts. It never runs in default suites.

For each disposable project copy it currently:

1. Starts the AppImage with an isolated HOME, external Node/npm and no `pi` on PATH; opens the project and confirms launch; selects the model.
2. For each task, picks the declared desktop/mobile elements, optionally hands preview control to the agent, sends the prompt, approves only `Approve browser action` dialogs, denies every other approval and cancels agent questions, then records the response, approvals and an external Git diff committed per task.
3. Closes and reopens twice, quits and restarts the app, and checks credentials, retained edits, owned processes and integration artifacts.

Evidence (report JSON, screenshots, diffs) stays outside Git in the plan's evidence directory.

## Known limits of live runs

- Any failed browser action, including a preview that reloaded after an edit, returns control to the user; the agent must ask for a new handoff.
- Navigation, including in-page anchors, invalidates control by design.
- Browser tools cannot dispatch drags or toggle `prefers-reduced-motion`; motion behavior still needs a human check.
- A run that hits its turn or time budget stops, and chat names the limit ([run recovery](../tests/browser-e2e/agent-run-recovery.spec.ts)).

When the audit run is complete and the maintainer has signed off, update the [acceptance gate](acceptance.md). Until then no AppImage is published as a release.
