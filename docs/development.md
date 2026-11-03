# Development

The repository keeps reproducible tests, fixtures, and build tooling—not historical test reports or per-issue verification harnesses. Tests are not shipped in the AppImage. Application code lives in `src/presentation`, `src/application`, and `src/infrastructure`.

## Requirements

- Linux with Node.js 22 and npm; install the pinned dependencies with `npm ci`.
- A graphical desktop and Electron's system libraries for application/E2E runs.
- Trusted system `/usr/bin/python3` and a supported 64-bit Linux filesystem for managed-file metadata checks. See [changes and recovery](changes-and-recovery.md) for the same-filesystem and metadata restrictions.

```bash
npm run dev          # renderer and Electron host
npm run check        # TypeScript and unit tests; no paid model calls
npm run build        # renderer, host, preload, and preview bridge
npm run dist:linux   # AppImage in release/
```

## Integration checks

Run suites sequentially: they share fixture files and local ports.

| Command | Coverage |
| --- | --- |
| `npm run test:e2e` | Vite/Next workspace, selection, exact JSX provenance, Motion/GSAP, delayed Next streaming, capture, routing, and HMR |
| `npm run test:audit-e2e` | Responsive audit on fixture labs: `responsive-audit` (Vite `/audit-lab.html`: every planted bug, review item and scroller gap, silent negatives, verified and unverified sources, **Show at &lt;width&gt;**, **Fix with agent** attachment, a truncated scan that keeps a finding unverified and resolution after a CSS fix), `next-audit` (Next.js App Router `/audit-lab` on Webpack, including a CSS module fix), `interaction-audit` (`/audit-interactions.html`: focus walk, disclosures and hover without clicking navigating triggers), `axe-audit` (`/audit-axe.html`: axe-core at the width profiles) and `site-audit` (discovery, skipped links, batch, Stop). Writes report JSON, profile snapshots and screenshots to `test-results/audit/` |
| `npm run test:browser-e2e` | Visible-preview control, exact approvals, stale targets, revocation, checks, embedding headers, selection handoff and run recovery (`visible-browser`, `browser-operations`, `preview-headers`, `selection-handoff`, `agent-run-recovery`), plus the agent fix-and-verify loop with `responsive_audit` (`audit-agent-loop`) and its `routes` batch (`audit-agent-site`), all with a local fake model |
| `npm run test:session-e2e` | Disposable Vite/Next Webpack/Turbopack imports, occupied ports, private caches, preservation of source/config/types and abrupt-owner recovery |
| `npm run test:lifecycle-e2e` | Project close/reopen, layout persistence, and integration cleanup |
| `npm run test:setup-e2e` | Approved setup UI, nested diff disclosures, diagnostics, motion/accessibility, and native Electron picker IPC (OS dialog result stubbed; real temporary-project discovery) |
| `npm run test:turbopack-e2e` | Next.js Turbopack preview bridge without changing `next.config` (`next-turbopack`), and the same Next audit lab suite under Turbopack (`audit-lab`); artifacts in `test-results/turbopack/` |
| `npm run test:release-gates` | Moved-hook recovery conflicts, owned descendant cleanup, and bounded newline-free logs |
| `npm run dist:linux && npm run test:package-e2e` | Actual AppImage, external Node/npm without pi on PATH, Chromium sandbox enabled, local fake provider, dual capture pixels, cookie/IPC boundaries, selected editing/visible checks/undo and reopen isolation for Vite and Next |
| `MAUXI_LIVE_PLAN=/private/plan.json npm run test:live-acceptance` | Opt-in only; uses a real provider. Drives the AppImage through live-model agent tasks on nominated real projects, then close/reopen/restart cleanup. It must be adapted for the audit tasks before the next run. Plan format, audit run requirements and results: [real-project run](real-project-acceptance.md) |

The workspace, audit and Turbopack scripts install temporary fixture instrumentation and clean it through shell traps. Other integration suites exercise project setup directly; the browser suite opens the Vite fixture through setup on a session port Mauxi assigns. The shell uses port 44173, Vite uses 45173, Next Webpack uses 45000 (the audit suite starts these or reuses running ones), and the Turbopack suite uses 45001 with the shell on 44173. Do not run them against personal projects or unrelated servers.

Browser-only Playwright suites (`test:setup-e2e`, the `selection-composer` spec in `test:e2e`, and the production checks) accept `MAUXI_CHROMIUM_PATH=/path/to/chromium` to launch an already-installed Chromium when the exact Playwright browser build is unavailable; unset, they use Playwright's own build. When tests run as root, `preview-headers` in `test:browser-e2e` launches without the Chromium sandbox (Chromium cannot sandbox root) and skips its `--no-sandbox` assertion, and the capture-cache unit test denies deletion with `chattr +i` instead of `chmod`, which needs an ext-style filesystem.

`npm run verify:production` builds the fixtures, scans their output for bridge signatures, and runs hydrated production browser checks on ports 45273/45274. It requires Playwright Chromium (`npx playwright install chromium` if not already installed, or `MAUXI_CHROMIUM_PATH`). These production checks are separate from agent verification of the visible workspace. To exercise exclusion with the temporary hooks installed:

```bash
(
  export MAUXI_STATE_DIR="$PWD/.mauxi-proof-state"
  trap 'npm run instrument:clean' EXIT
  npm run build:host && npm run instrument:apply && npm run verify:production
)
```

Do not delete recovery state to resolve a failed cleanup. Inspect conflicts and use the recovery guidance instead.

## README screenshot

`npm run docs:screenshot` regenerates `docs/images/mauxi-workspace.png`: it opens the Vite audit lab with a local fake model, waits for the entry audit and captures the window with the first finding expanded. It needs a graphical display (or Xvfb). The spec is skipped in `test:browser-e2e` unless `MAUXI_README_SCREENSHOT=1` is set, so ordinary runs never overwrite the image. Commit the new image only after looking at it.

## Generated output

Playwright writes screenshots, JSON diagnostics, stderr, traces, and failure artifacts under **`test-results/<suite>/`**. Test-owned files use `testInfo.outputPath()` so they get a test-specific directory and do not depend on checked-in artifact folders. The workspace capture tests share their Electron session and capture folder within the test file. Each suite refreshes its own output; other suites' output is left alone. The package suite records the tested AppImage digest/runtime/cycles. Failed package projects and recovery journals are retained in a temporary directory identified by `recovery-location.txt`; inspect before removing them. The workspace HTML report goes in **`playwright-report/`**.

Both folders are ignored and disposable when no test is running. Do not commit generated output or recreate per-issue evidence folders. For a release or bug report that needs retained artifacts, attach the relevant files to that release/issue or store them outside the repository. Historical committed reports remain available through Git history.

`.mauxi-*-state/` folders are different: they may contain unfinished recovery journals and are not ordinary disposable test reports. Build outputs (`dist/`, `dist-electron/`, `release/`) are ignored separately.

## Release gate

See the [acceptance table](acceptance.md) and [usage notes](usage.md). `npm run check` remains the fast deterministic owner-test suite, not release certification. Release gates and package checks assert actual required behavior; the missing real-project audit run (AC-19) and its founder sign-off still block acceptance even when these suites pass. Build packaging uses pinned `electron-builder` 26.15.3 with `--publish never`. This includes the AppImage runtime search-path fix described in [GHSA-7g7r-gx96-252g](https://github.com/electron-userland/electron-builder/security/advisories/GHSA-7g7r-gx96-252g). `MAUXI_APPIMAGE=/absolute/path` can select a candidate for `test:package-e2e`; otherwise it tests `release/Mauxi-0.1.0-x86_64.AppImage`. Rebuild before claiming evidence for source changes.

## What these checks do not establish

Local fake providers keep unit tests deterministic and free of paid model calls. Passing them does not establish live subscription/API compatibility, audit accuracy on real projects, real-model fix quality, human acceptance, real-device behavior, or full authenticated AppImage acceptance. Live provider testing must be explicitly authorized and cost-bounded. Avoid maintaining frozen pass counts in documentation; run the relevant commands for current results.
