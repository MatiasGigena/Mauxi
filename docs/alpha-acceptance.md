# Linux private-alpha acceptance gate

**NOT ACCEPTED — issue [#9](https://github.com/MatiasGigena/Mauxi/issues/9) stays open.**

This is the release checklist, not a claim that passing unit tests establish an alpha. A **partial**, **failed**, or **blocked** row is incomplete. Re-run the linked tests after fixes; do not convert missing evidence into a pass or suppress the failing release tests. Generated reports stay outside Git (see [development](development.md)). Setup/recovery instructions: [private-alpha notes](private-alpha.md).

## Declared scope and decisions

- Actual machine: **Linux Mint 22.3**, Ubuntu 24.04/noble base, kernel `7.0.0-31-generic`, X11, x86_64, Ryzen 7 5825U/Radeon, approximately 14 GiB usable RAM. Not Ubuntu distribution certification. No Wayland, other GPU/distro, macOS, or Windows claim.
- Target toolchain: Node `22.23.1`, npm `10.9.8`. App runtime: Electron `44.4.1`, Chromium `152.0.7977.78`, embedded Node `24.21.0`; SDK `0.86.1`.
- Fixtures: React/React DOM `19.3.0`; Vite `7.3.6` with React plugin `5.1.1`; Next `16.3.5` App Router/Webpack. Turbopack evidence is **bridge loading only**, not a full supported design loop. Pages Router is unverified.
- O-03: founder explicitly deferred nomination of real Vite/Next projects. No private projects were selected, modified, or copied into fixtures.
- O-05: founder approved x86_64 AppImage validation on this machine. Extraction fallback tested; FUSE/desktop installation on other tester machines is unverified. `dist:linux` explicitly uses `--publish never`.
- O-06: founder approved existing checkpoint/vault admission limits and manual recovery cleanup. Unbounded ordinary retention remains an explicit blocker, [#13](https://github.com/MatiasGigena/Mauxi/issues/13).
- Live-provider/model-quality acceptance: explicitly deferred by founder; **authorized cost cap $0; actual model credits spent $0**. Local fake-provider responses go through the bundled SDK. No real authentication/subscription/API-quality result is implied.

## AC-01 through AC-21

Statuses below describe the 2026-09-22 validation run, not evergreen guarantees. The dated run receipt/digest is on #9; raw artifacts are retained privately outside the repository.

| AC | Status | Reproducible evidence and outstanding condition |
| --- | --- | --- |
| AC-01 | Pass, fixture scope | [Discovery/ownership tests](../tests/unit/project-lifecycle.test.ts), [lifecycle E2E](../tests/lifecycle-e2e/project-lifecycle.spec.ts), [AppImage Vite test](../tests/package-e2e/private-alpha.spec.ts): confirmed launch, both bridges, occupied-port refusal and external-server preservation. Descendant failure is separately blocking AC-14/20. |
| AC-02 | Pass, fixture scope | [Workspace E2E](../tests/e2e/workspace.spec.ts): interactive transformed previews, dragging/wheel/input and true viewport breakpoints. No device emulation claim. |
| AC-03 | Pass, fixture scope | Workspace E2E: page-instance/form state and prior camera survive focus/unfocus; keyboard/chat remain usable. |
| AC-04 | Partial | Workspace picker test covers 25/50/100/200% zoom, pan/scroll, nested SVG, portals/overlap and zero underlying action. Full display-scale/target cross-product is not recorded; moving Motion/GSAP targets are missing ([#14](https://github.com/MatiasGigena/Mauxi/issues/14)). |
| AC-05 | Partial | [Core E2E](../tests/e2e/core-interaction.spec.ts), [DOM source](../tests/unit/dom-source.test.ts), workspace hierarchy/unsupported tests. Exact expected line/column/provenance for **every** declared fixture is not yet asserted; #14. A matching filename/“verified” label alone is insufficient. |
| AC-06 | Partial | [Context unit tests](../tests/unit/agent-contract.test.ts), core dual-preview captures, workspace inspect/remove/redaction, packaged selected-image request. One real packaged request with both previews' captures and independently checked screenshot regions remains unrecorded. |
| AC-07 | Pass, current fixture scope | [Selection-state tests](../tests/unit/selection-state.test.ts), core HMR, workspace reorder/remount/navigation, [visible-browser E2E](../tests/browser-e2e/visible-browser.spec.ts) stale handles. Next managed-write HMR itself fails AC-13. |
| AC-08 | Pass, fixture scope | Workspace/core navigation tests and visible-browser local side-effect counter: one peer route update, no replayed POST/click, unlink/copy and unsafe callback exclusion. |
| AC-09 | Pass, deterministic scope | [Browser ownership](../tests/unit/browser-control.test.ts), [SDK browser integration](../tests/unit/browser-agent.test.ts), [visible operations](../tests/browser-e2e/browser-operations.spec.ts). Actual visible screenshots, stale generations, exact approval, take-back, stop/error/disconnect; no duplicate verification browser. |
| AC-10 | Pass, deterministic scope | Agent-contract SDK test: structured question, stream, steer/follow-up, stop/new/resume and one host. AppImage test uses the bundled SDK with no pi executable on PATH. Quiet chat intentionally shows working status rather than token-by-token narration. |
| AC-11 | Partial / live blocked | Agent-contract and AppImage tests cover fake API-key setup/cancel/re-auth and model selection without exposing stored keys to the renderer. Representative real OAuth/API flows and full expired-auth/catalog-error matrix remain unverified. No live account authorized. |
| AC-12 | Pass, deterministic scope | [Command approvals](../tests/unit/command-approval.test.ts), [managed boundaries](../tests/unit/change-coordinator.test.ts), browser approvals, [resource rejection](../tests/unit/design-resources.test.ts)/[dialogs](../tests/unit/design-workflow.test.ts): denial, changed meaning, missing UI, scope escape, revocation fail closed. Trusted project commands are not OS-sandboxed. |
| AC-13 | **Failed** | Packaged Vite selected edit → HMR in both previews → expanded diff (source path, agent attribution, removed/added source lines) → visible checks → undo passes. Packaged Next managed edit leaves stale previews after transient ENOENT: [#11](https://github.com/MatiasGigena/Mauxi/issues/11), owner #6. Ordinary writeFile HMR tests do not cover this bug. |
| AC-14 | **Failed in edge case** | [Instrumentation tests](../tests/unit/instrumentation.test.ts) preserve Git index/dirty work; normal packaged Vite cycles preserve user edits and stop observed PIDs. [Release gates](../tests/release-gates/lifecycle-blockers.test.ts) expose an owned descendant left running after its launcher exits: [#12](https://github.com/MatiasGigena/Mauxi/issues/12), owner #2. |
| AC-15 | Pass, tested edit cases | Instrumentation tests and lifecycle E2E preserve concurrent edits outside the owned region; edits inside it/artifacts cause visible conflicts; retry is safe. Does not claim race-proof instrumentation against hostile same-user writers. |
| AC-16 | **Failed / partial matrix** | [Crash recovery](../tests/unit/instrumentation-recovery.test.ts) actually SIGKILLs disposable children before/after every journal-write boundary for both adapters, then recovers idempotently or reports conflict. Moved artifact/unpersisted-patch release gates incorrectly report clean (#12). Power-loss, every mid-filesystem-operation window, and complete real Git-checkout matrix are not proven. |
| AC-17 | Pass, pinned production scope | `verify:production` with inactive residual hooks present: both builds, [output signature scan](../scripts/verify-production.ts), and [production browser smoke](../tests/production-e2e/production.spec.ts). Hydrated buttons work even with a Mauxi query string; no bridge request/metadata/page error. |
| AC-18 | Partial | Browser/selection/command tests reject forged capabilities, origins/IDs and escaping source hints; AppImage Vite opens two canonical roots at the **same origin** and proves localStorage isolation, shared within each workspace and persistent on reopen. Full cookie/credential IPC attack matrix across packaged workspaces is not recorded. |
| AC-19 | **Blocked** | Founder nomination and live-provider budget deferred. Layout refinement, polish, animation, relevant skill use, visible verification, review/undo and human quality assessment on both real projects still required. No mock substitutes. |
| AC-20 | **Failed / live blocked** | `test:package-e2e`: actual AppImage (not linux-unpacked/dev host), separate HOME, whitelisted environment, external Node/npm, no pi on PATH, real SDK with loopback fake. Vite full loop and four open/close cycles across two roots plus app quit/reopen pass, with filesystem/config and owned-PID checks after every close, including the final reopen. Next full loop fails #11; real auth and adverse process cleanup #12 remain blockers. |
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
npm run test:release-gates   # currently FAILS three safety contracts; not skipped/xfail
npm run dist:linux          # --publish never
npm run test:package-e2e    # currently FAILS Next; Vite passes
```

Production exclusion with residual hooks (cleaned on exit):

```bash
(
  export MAUXI_STATE_DIR="$PWD/.mauxi-proof-state" NEXT_TELEMETRY_DISABLED=1
  trap 'npm run instrument:clean' EXIT
  npm run build:host && npm run instrument:apply && npm run verify:production
)
```

- Setup/cleanup interruption: real child-process SIGKILL at journal boundaries; unreadable/failed journal persistence. Remaining move/branch windows stay visible in AC-16.
- Concurrent edits, conflicting undo, stale/same-content inode replacement, interrupted command observations, checkpoint failure, capacity exhaustion and staged-intent failure: `change-coordinator.test.ts`. These are fault injection/admission tests, **not** a physical disk-full/power-loss certification.
- SDK session replacement, auth cancel, model failure, command denial, browser revocation/disconnect: owning agent/browser/command tests. Missing real auth evidence stays AC-11 incomplete.
- Ordinary CSS and client hydration/routes pass; **Motion/GSAP and delayed Next streaming are absent**, tracked against owner #1 in #14. Turbopack smoke does not establish that matrix.

## Responsiveness and UI review

The packaged Vite test samples renderer rAF/long tasks while the actual SDK streams a delayed fake response, both previews are live, chat accepts text, Stop is visible, and keyboard artboard movement works. The recorded local sample had 124 frames, p95/max about **16.8 ms**, and no observed long tasks. This is a short sample, not an input-latency percentile, GPU benchmark, or real-model stress certification. No demonstrated shell bottleneck warranted speculative workers or animation infrastructure. Next's failed update is a correctness blocker, not something to hide by averaging performance.

## Evidence handling and remaining sign-off

Per-suite captures/traces/JSON use `testInfo.outputPath()` under ignored `test-results/`. Package JSON records the **actual artifact SHA-256**, runtime versions, completed cycles/PIDs, local-provider limits and responsiveness sample. A failed package run retains its disposable project/journals and writes `recovery-location.txt`; review before deletion. Production commands can legitimately rewrite Next-generated `next-env.d.ts`/caches; these are not Mauxi source edits.

Archive the relevant run output **outside the repository** before rerunning suites. Never upload private projects, provider credentials, session bodies or arbitrary screenshots to a public issue. The #9 comment records the candidate digest and concise results; no public release was published.

To accept: resolve #11–#14, finish every partial row, nominate both real projects, authorize a separate cost-capped representative provider run, record private/manual evidence and human assessment, then revalidate the final artifact. In future live runs, record provider/model/auth type, prompts, token/cost totals and omissions; use a provider-enforced spend limit where available. Turn/time limits are **not dollar caps**. Until approval changes, do not send any live request.
