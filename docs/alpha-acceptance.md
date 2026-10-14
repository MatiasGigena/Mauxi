# Linux private-alpha acceptance gate

**NOT ACCEPTED — issue [#9](https://github.com/MatiasGigena/Mauxi/issues/9) stays open.**

This is the active release checklist, not a historical test receipt. Passing unit tests alone does not establish an alpha. Re-run the required checks against the current source and rebuilt artifact; record results outside the repository. Setup/recovery instructions: [private-alpha notes](private-alpha.md). Test commands and artifact handling: [development](development.md).

## Scope and remaining blockers

- Linux x86_64 AppImage is the private-alpha target. Other distributions, GPUs, Wayland, FUSE/desktop installation, macOS and Windows are not certified.
- React/Vite and Next.js App Router/Webpack fixtures use the versions pinned in their lockfiles. Turbopack coverage is bridge loading only; Pages Router and other versions remain unverified.
- Real-project design-agent work, representative live authentication and human design-quality acceptance remain incomplete. Nominated projects and the outstanding workflow are in the [remaining private run](real-project-acceptance.md).
- Live-provider testing requires separate account/provider authorization and a cost cap. Current authorized spend is **$0**. Local fake providers do not establish real authentication or model quality; turn/time limits are not dollar caps.
- The legacy Next source-picking gate expects `jsx-attribute` but receives `react-grab`. Keep the exact provenance assertions; resolve the mismatch before claiming the gate passes.
- Package tests must validate the current minimal UI: browser handoff beside Send, route linking in preview actions, and project close in the repository-title menu. Removed diff/Undo, session-management, Checks, and Fit/Reset/Hand controls are not current user flows. Trusted-host tests still exercise checkpoint/undo safeguards. Rebuild and rerun the package gate before claiming packaged-release validation.

## Required checks

The rows define required behavior, not a frozen pass/fail report. Every row needs current results within its declared scope; a partial, failed or blocked check is incomplete.

| AC | Required validation |
| --- | --- |
| AC-01 | [Discovery/ownership](../tests/unit/project-lifecycle.test.ts), [lifecycle](../tests/lifecycle-e2e/project-lifecycle.spec.ts) and [package](../tests/package-e2e/private-alpha.spec.ts): confirmed launch, both bridges, occupied-port refusal and external-server preservation, including early-exiting launchers. |
| AC-02 | [Workspace](../tests/e2e/workspace.spec.ts): transformed previews remain interactive, including dragging, wheel/input and true viewport breakpoints. Viewports are not device emulation. |
| AC-03 | Workspace: focus/unfocus preserves page-instance/form state and prior camera; keyboard/chat remain usable. |
| AC-04 | [Acceptance matrix](../tests/e2e/acceptance-matrix.spec.ts): exact picking with no underlying clicks across static, Motion/GSAP, nested SVG, portal/overlap/nested-scroll and Next server targets; 25/50/100/200% zoom and 1×/2× display scales. |
| AC-05 | Acceptance matrix: independently declared JSX anchors and source hashes match exact file, line, column and method. Ambiguous repeated IDs stay unresolved; ownership labels do not prove arbitrary component mappings. Canvas pixels are unsupported. |
| AC-06 | [Context](../tests/unit/agent-contract.test.ts), workspace and package: inspect/remove/redact selection context; request includes both preview captures with correct labels, source hashes, attachment order and distinguishable crop pixels. |
| AC-07 | [Selection state](../tests/unit/selection-state.test.ts), workspace, package and [visible browser](../tests/browser-e2e/visible-browser.spec.ts): HMR, reorder/remount/navigation and stale handles do not reuse invalid selection identity. |
| AC-08 | Workspace and visible-browser navigation: one peer route update, no replayed POST/click, unlink/copy and unsafe-callback exclusion. |
| AC-09 | [Browser ownership](../tests/unit/browser-control.test.ts), [agent integration](../tests/unit/browser-agent.test.ts) and [visible operations](../tests/browser-e2e/browser-operations.spec.ts): same visible previews, exact approvals, stale generations, take-back and stop/error/disconnect. |
| AC-10 | Agent-contract and package: structured question, steer/follow-up, stop and one bundled SDK host; no terminal pi dependency. New/resume behavior is trusted-host coverage, not a renderer history picker. |
| AC-11 | Agent-contract/package fake setup, cancellation, re-auth, expired authentication, model selection and catalog errors/timeouts without exposing keys; separately authorized representative real OAuth/API authentication. **Live portion blocked.** |
| AC-12 | [Command approval](../tests/unit/command-approval.test.ts), [managed boundaries](../tests/unit/change-coordinator.test.ts), browser approvals and [design resources](../tests/unit/design-resources.test.ts): denial, changed meaning, missing UI, scope escape and revocation fail closed. Trusted commands are not OS-sandboxed. |
| AC-13 | Package and managed-boundary tests: selected edits reach both previews, external diff confirms the change, visible checks run, and trusted-host undo restores eligible changes. Atomic Linux exchange retains displaced data; concurrent changes conflict and preserve recovery. |
| AC-14 | [Instrumentation](../tests/unit/instrumentation.test.ts), package and [release gates](../tests/release-gates/lifecycle-blockers.test.ts): preserve Git index/dirty work, remove owned hooks and stop ordinary owned descendants even if the launcher exited. |
| AC-15 | Instrumentation/lifecycle: preserve edits outside owned regions; edits inside them or owned artifacts produce visible, repeatable conflicts. No hostile-writer race-proof guarantee. |
| AC-16 | [Crash recovery](../tests/unit/instrumentation-recovery.test.ts) and release gates: SIGKILL at setup/cleanup journal boundaries, branch switches, tracked-file moves and unpersisted patches preserve data and explicit conflicts. Uncertain absence is not completed cleanup. Physical power loss remains outside scope. |
| AC-17 | [Production signature scan](../scripts/verify-production.ts) and [hydrated production checks](../tests/production-e2e/production.spec.ts): inactive residual hooks do not ship bridge requests/metadata or page errors; buttons work even with Mauxi query parameters. |
| AC-18 | Package/browser/selection/command boundaries: reject forged capabilities, origins/IDs and escaping hints; same-origin canonical workspaces isolate cookies/storage while one workspace shares them. Preview content has no host/Node API; privileged IPC rejects untrusted renderers; credentials survive restart without renderer disclosure. Not general security certification. |
| AC-19 | Both real projects: responsive refinement, component polish, animation, relevant skill use, visible verification, external diff and human quality assessment. **Not run; no mock substitute.** |
| AC-20 | Actual rebuilt AppImage with Chromium sandbox enabled, isolated HOME/environment, external Node/npm and no pi executable: Vite/Next edit/check, open/close, quit/reopen, filesystem/config preservation and owned-process cleanup. Representative real-provider authentication remains blocked. |
| AC-21 | Human UI review plus workspace/resource/browser checks: direct manipulation, interruption/rapid focus reversal, keyboard/modal focus, typing, readable text, reduced motion/contrast, explicit approvals/take-back and transient settings. Inspect current screenshots; other-machine performance needs separate validation. |

## Failure coverage and sign-off

Retain regression coverage for interrupted setup/cleanup, concurrent edits, conflicting undo, inode replacement, checkpoint/journal persistence failures, capacity exhaustion, stale browser targets and authentication cancellation. [Storage admission](../tests/unit/artifact-budget.test.ts) and [capture cleanup](../tests/unit/capture-cache.test.ts) must preserve protected attachments, conversations and recovery data; see the [storage policy](private-alpha.md#capacity-and-explicit-cleanup). Fault injection is not physical disk-full/power-loss certification.

Run integration suites sequentially using the [development commands](development.md#integration-checks), including residual-hook production exclusion and the rebuilt package gate. Never suppress a failing gate or treat an old artifact's results as current-source validation.

Keep receipts, screenshots, traces, artifact digests, runtime versions, process cleanup results and responsiveness samples outside Git. Review failed package projects and unfinished journals before deletion. Do not publish private projects, credentials, session bodies or arbitrary screenshots. Live runs need an approved budget and a private usage receipt.

Complete every required check and the remaining real-project run, identify the exact rebuilt artifact, and obtain tester-delivery approval before acceptance. No public release is authorized.
