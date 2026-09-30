# Linux private-alpha acceptance gate

**NOT ACCEPTED — issue [#9](https://github.com/MatiasGigena/Mauxi/issues/9) stays open.**

This is the release checklist, not a claim that passing unit tests establish an alpha. A **partial**, **failed**, or **blocked** row is incomplete. Re-run the linked tests after fixes; do not convert missing evidence into a pass or suppress the failing release tests. Generated reports stay outside Git (see [development](development.md)). Setup/recovery instructions: [private-alpha notes](private-alpha.md).

## Declared scope and decisions

- Actual machine: **Linux Mint 22.3**, Ubuntu 24.04/noble base, kernel `7.0.0-31-generic`, X11, x86_64, Ryzen 7 5825U/Radeon, approximately 14 GiB usable RAM. Not Ubuntu distribution certification. No Wayland, other GPU/distro, macOS, or Windows claim.
- Target toolchain: Node `22.23.1`, npm `10.9.8`. App runtime: Electron `44.4.1`, Chromium `152.0.7977.78`, embedded Node `24.21.0`; SDK `0.86.1`.
- Fixtures: React/React DOM `19.3.0`; Vite `7.3.6` with React plugin `5.1.1`; Next `16.3.5` App Router/Webpack; Motion `13.4.1`, GSAP `3.15.0`. Turbopack evidence is **bridge loading only**, not a full supported design loop. Pages Router is unverified.
- O-03: founder explicitly deferred nomination of real Vite/Next projects. No private projects were selected, modified, or copied into fixtures.
- O-05: founder approved x86_64 AppImage validation on this machine. Extraction fallback tested; FUSE/desktop installation on other tester machines is unverified. `dist:linux` explicitly uses `--publish never`.
- O-06: founder approved existing checkpoint/vault admission limits and manual recovery cleanup. Ordinary captures, SDK sessions and instrumentation journals have app-wide admission budgets. The founder subsequently approved immediate disposable selection cleanup and 24-hour/capacity-based preview retention; SDK history and recovery still require explicit manual cleanup; see [storage policy](private-alpha.md#capacity-and-explicit-cleanup) and [bound tests](../tests/unit/artifact-budget.test.ts) for #13.
- Live-provider/model-quality acceptance: explicitly deferred by founder; **authorized cost cap $0; actual model credits spent $0**. Local fake-provider responses go through the bundled SDK. No real authentication/subscription/API-quality result is implied.

## Integrated validation — 2026-09-22

Local validation passed TypeScript and 219 unit tests, 5 release regressions, 19 workspace tests (including the exact provenance/motion/streaming matrix), 3 visible-browser tests, and the lifecycle, Turbopack bridge and resource suites. Both residual-hook production builds, the output-signature scan and 2 hydrated production browser tests passed. `npm audit` reports zero known vulnerabilities; packaging uses electron-builder `26.15.3`.

This run fixed false JSX locations for nested text, lost Next bridge bootstrap after document navigation, and browser-control revocation on Next's same-URL hydration history update. The packaged shell now serves bundled assets on an ephemeral loopback origin so ordinary preview session cookies work without relaxing the same-origin boundary.

Candidate: `release/Mauxi-0.1.0-x86_64.AppImage`, SHA-256 `b8b1efb8551d1cc298ab35a504690bacbe107400a0ef6c712b27ad2a47efde54`. The dated private receipt accompanies the artifact. This is a local validation candidate, not alpha approval. Real projects, representative live authentication and human design-quality acceptance remain unexecuted. **Model credits spent: $0.**

## AC-01 through AC-21

Statuses below describe the 2026-09-22 validation run, not evergreen guarantees. The dated run receipt/digest is on #9; raw artifacts are retained privately outside the repository.

| AC | Status | Reproducible evidence and outstanding condition |
| --- | --- | --- |
| AC-01 | Pass, fixture scope | [Discovery/ownership tests](../tests/unit/project-lifecycle.test.ts), [lifecycle E2E](../tests/lifecycle-e2e/project-lifecycle.spec.ts), [AppImage Vite test](../tests/package-e2e/private-alpha.spec.ts): confirmed launch, both bridges, occupied-port refusal and external-server preservation. The early-exiting launcher regression is covered separately by the release gates. |
| AC-02 | Pass, fixture scope | [Workspace E2E](../tests/e2e/workspace.spec.ts): interactive transformed previews, dragging/wheel/input and true viewport breakpoints. No device emulation claim. |
| AC-03 | Pass, fixture scope | Workspace E2E: page-instance/form state and prior camera survive focus/unfocus; keyboard/chat remain usable. |
| AC-04 | Pass, declared fixture matrix | [Acceptance E2E](../tests/e2e/acceptance-matrix.spec.ts): Motion/GSAP targets and nested SVG at 25/50/100/200% zoom with page scrolling/pan, display scales 1×/2×; exact provenance and zero underlying clicks. The same zoom/display cross-product includes static buttons, Vite portal/overlap/nested-scroll and Next server heading/nested-scroll. Other display scales are unverified. |
| AC-05 | Pass, declared source matrix | Acceptance E2E compares explicit JSX anchors against exact file, line, column, method and independently hashed source: Vite/Next client buttons and their nested text spans, nested SVG paths, Motion/GSAP, Vite portal/overlap/nested-scroll and Next server heading/nested-scroll. Dynamic repeated test IDs remain explicitly `missing-or-ambiguous`; canvas pixels remain unsupported. Runtime ownership labels do not establish arbitrary library/component mappings. |
| AC-06 | Pass, deterministic package scope | [Context unit tests](../tests/unit/agent-contract.test.ts), workspace inspect/remove/redaction and AppImage requests containing both preview captures. The package test verifies each preview/workspace label, source hash, attachment order and independently distinguishes red desktop/blue mobile crop pixels (allowing display color-profile conversion). |
| AC-07 | Pass, current fixture scope | [Selection-state tests](../tests/unit/selection-state.test.ts), core HMR, workspace reorder/remount/navigation, [visible-browser E2E](../tests/browser-e2e/visible-browser.spec.ts) stale handles. Managed Next edit/undo HMR is now covered by the packaged loop in AC-13. |
| AC-08 | Pass, fixture scope | Workspace/core navigation tests and visible-browser local side-effect counter: one peer route update, no replayed POST/click, unlink/copy and unsafe callback exclusion. |
| AC-09 | Pass, deterministic scope | [Browser ownership](../tests/unit/browser-control.test.ts), [SDK browser integration](../tests/unit/browser-agent.test.ts), [visible operations](../tests/browser-e2e/browser-operations.spec.ts). Actual visible screenshots, stale generations, exact approval, take-back, stop/error/disconnect; no duplicate verification browser. |
| AC-10 | Pass, deterministic scope | Agent-contract SDK test: structured question, stream, steer/follow-up, stop/new/resume and one host. AppImage test uses the bundled SDK with no pi executable on PATH. Quiet chat intentionally shows working status rather than token-by-token narration. |
| AC-11 | Fake flows pass / live blocked | Agent-contract and AppImage tests cover fake API-key setup/cancel/re-auth, 401 expired authentication and recovery, model selection, cached catalog preservation on SDK catalog error/timeout, without exposing stored keys. Representative real OAuth/API flows remain unverified; no live account authorized. |
| AC-12 | Pass, deterministic scope | [Command approvals](../tests/unit/command-approval.test.ts), [managed boundaries](../tests/unit/change-coordinator.test.ts), browser approvals, [resource rejection](../tests/unit/design-resources.test.ts)/[dialogs](../tests/unit/design-workflow.test.ts): denial, changed meaning, missing UI, scope escape, revocation fail closed. Trusted project commands are not OS-sandboxed. |
| AC-13 | Pass, deterministic fixture scope | [Packaged Vite and Next tests](../tests/package-e2e/private-alpha.spec.ts): selected edit → both live previews → expanded diff → visible checks → undo. Existing-file replacement now uses an atomic Linux exchange, preserving displaced data without the missing-name window from #11. Concurrent changes still conflict and retain recovery data. |
| AC-14 | Pass, tested fixture/process scope | [Instrumentation tests](../tests/unit/instrumentation.test.ts) preserve Git index/dirty work. Packaged cycles preserve user edits and stop observed PIDs. [Release gates](../tests/release-gates/lifecycle-blockers.test.ts) now stop ordinary owned descendants even after their launcher exits (#12). |
| AC-15 | Pass, tested edit cases | Instrumentation tests and lifecycle E2E preserve concurrent edits outside the owned region; edits inside it/artifacts cause visible conflicts; retry is safe. Does not claim race-proof instrumentation against hostile same-user writers. |
| AC-16 | Pass, declared transaction/Git matrix | [Crash recovery](../tests/unit/instrumentation-recovery.test.ts) SIGKILLs disposable children before/after each setup/cleanup journal boundary for both adapters. Real Git branch switches and tracked-file moves preserve current branch content/index and remain explicit, repeatable conflicts. Release gates cover moved artifacts/unpersisted patches, including replacement by original source. Cleanup receipts distinguish completed removal from uncertain absence. Physical power loss and every mid-syscall window remain outside this evidence. |
| AC-17 | Pass, pinned production scope | `verify:production` with inactive residual hooks present: both builds, [output signature scan](../scripts/verify-production.ts), and [production browser smoke](../tests/production-e2e/production.spec.ts). Hydrated buttons work even with a Mauxi query string; no bridge request/metadata/page error. |
| AC-18 | Pass, declared packaged boundary matrix | Browser/selection/command tests reject forged capabilities, origins/IDs and escaping hints. AppImage tests prove localStorage and SameSite cookie isolation across canonical roots at the **same origin**, sharing within a workspace and persistence on reopen; Vite client/Next HttpOnly login works. All 30 registered privileged IPC channels reject a separate untrusted renderer, actual previews expose no host/Node API, and stored provider-auth bytes survive restart without appearing in renderer snapshots. This is the declared attack matrix, not a general security certification. |
| AC-19 | **Blocked** | Founder nomination and live-provider budget deferred. Layout refinement, polish, animation, relevant skill use, visible verification, review/undo and human quality assessment on both real projects still required. No mock substitutes. |
| AC-20 | Pass, deterministic package scope / live blocked | `test:package-e2e`: actual AppImage with Chromium sandbox explicitly enabled in Playwright, separate HOME, whitelisted environment, external Node/npm, no pi on PATH, real SDK with loopback fake. Vite and Next edit/check/undo, open/close and app quit/reopen verify filesystem/config and owned PIDs. Real provider authentication remains deferred. |
| AC-21 | Pass, current machine/fixture review | `/apple-design` read and applied to review. Workspace/resource/browser tests exercise direct 1:1 manipulation, cancellation/rapid focus reversal, keyboard/modal focus, typing, 20px root text, reduced motion/contrast, explicit approvals/take-back and transient settings. Screenshots inspected: two previews + anchored chat, no permanent diagnostic/settings panel. No founder usability or other-machine performance claim. |

## Failure matrix and release commands

Run sequentially; fixture servers/ports are shared. No command below uses a paid model. Do not interpret `npm run check` alone as release approval.

```bash
npm run check
npm run test:e2e
npm run test:browser-e2e
npm run test:lifecycle-e2e
npm run test:turbopack-e2e
npm run build && npx playwright test --config playwright.resources.config.ts
npm run test:release-gates   # moved hooks, exited launcher descendants, newline-free logs
npm run dist:linux          # --publish never
npm run test:package-e2e    # both Vite and Next: selected edit, both previews, undo, cleanup
```

Production exclusion with residual hooks (cleaned on exit):

```bash
(
  export MAUXI_STATE_DIR="$PWD/.mauxi-proof-state" NEXT_TELEMETRY_DISABLED=1
  trap 'npm run instrument:clean' EXIT
  npm run build:host && npm run instrument:apply && npm run verify:production
)
```

- Setup/cleanup interruption: real child-process SIGKILL at journal boundaries; unreadable/failed journal persistence. Actual branch-switch and tracked-file-move cases are covered for both adapters; physical power loss is outside this evidence.
- Concurrent edits, conflicting undo, stale/same-content inode replacement, interrupted command observations, checkpoint failure, capacity exhaustion and staged-intent failure: `change-coordinator.test.ts`. These are fault injection/admission tests, **not** a physical disk-full/power-loss certification.
- Captures/sessions/journals: `artifact-budget.test.ts` tests exact byte/count capacity, app-wide cross-workspace SDK lazy flush/resume, preservation of history at capacity, and emergency recovery writes. `capture-cache.test.ts` additionally covers orphan cleanup above the capture limit, 24-hour preview expiry, count/byte watermarks, draft/in-flight protection, failed-send retries, bounded scans and preservation of embedded session images. No automatic history/recovery pruning; see the private-alpha storage policy. Newline-free logs are bounded by the release gates.
- SDK session replacement, auth cancel, model failure, command denial, browser revocation/disconnect: owning agent/browser/command tests. Missing real auth evidence stays AC-11 incomplete.
- Ordinary CSS plus pinned Motion/GSAP motion/reduced motion pass in the acceptance matrix. Next emits the Suspense fallback before the delayed server card, hydrates the card, preserves the source document across client transitions, and restores both bridges after peer document navigation. The Next client hook now recognizes same-origin frame bootstrap after query parameters disappear. Turbopack remains bridge-only scope.

## Responsiveness and UI review

The packaged Vite test samples renderer rAF/long tasks while the actual SDK streams a delayed fake response, both previews are live, chat accepts text, Stop is visible, and keyboard artboard movement works. The final sample values are recorded in the private package receipt; no input-latency or GPU claim is inferred from frame intervals. This is a short sample, not an input-latency percentile, GPU benchmark, or real-model stress certification. No demonstrated shell bottleneck warranted speculative workers or animation infrastructure. The Next regression is now validated separately through visible edit and undo assertions.

## Evidence handling and remaining sign-off

Per-suite captures/traces/JSON use `testInfo.outputPath()` under ignored `test-results/`. Package JSON records the **actual artifact SHA-256**, runtime versions, completed cycles/PIDs, local-provider limits and responsiveness sample. A failed package run retains its disposable project/journals and writes `recovery-location.txt`; review before deletion. Production commands can legitimately rewrite Next-generated `next-env.d.ts`/caches; these are not Mauxi source edits.

Archive the relevant run output **outside the repository** before rerunning suites. Never upload private projects, provider credentials, session bodies or arbitrary screenshots to a public issue. The #9 status records the candidate digest and concise results; no public release was published.

Use the [remaining real-project run receipt](real-project-acceptance.md). To accept: finish every partial row, nominate both real projects, authorize a separate cost-capped representative provider run, record private/manual evidence and human assessment, then revalidate the final artifact. In future live runs, record provider/model/auth type, prompts, token/cost totals and omissions; use a provider-enforced spend limit where available. Turn/time limits are **not dollar caps**. Until approval changes, do not send any live request.
