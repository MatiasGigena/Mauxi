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
| `npm run test:browser-e2e` | Visible-preview control, exact approvals, stale targets, revocation, and checks |
| `npm run test:lifecycle-e2e` | Project close/reopen, layout persistence, and integration cleanup |
| `npm run test:turbopack-e2e` | Next.js Turbopack preview bridge |
| `npm run build && npx playwright test --config playwright.resources.config.ts` | Local guidance import, settings, and invocation |
| `npm run test:release-gates` | Moved-hook recovery conflicts, owned descendant cleanup (#12), and bounded newline-free logs (#13) |
| `npm run dist:linux && npm run test:package-e2e` | Actual AppImage, external Node/npm without pi on PATH, Chromium sandbox enabled, local fake provider, dual capture pixels, cookie/IPC boundaries, selected editing/visible checks/undo and reopen isolation for Vite and Next (#11) |

The workspace/Turbopack scripts install temporary fixture instrumentation and clean it through shell traps. Other integration suites exercise project setup directly. The shell uses port 44173, Vite uses 45173, Next Webpack uses 45000, and the Turbopack suite uses 45001. Do not run them against personal projects or unrelated servers.

`npm run verify:production` builds the fixtures, scans their output for bridge signatures, and runs hydrated production browser checks on ports 45273/45274. It requires Playwright Chromium (`npx playwright install chromium` if not already installed). These production checks are separate from agent verification of the visible workspace. To exercise exclusion with the temporary hooks installed:

```bash
(
  export MAUXI_STATE_DIR="$PWD/.mauxi-proof-state"
  trap 'npm run instrument:clean' EXIT
  npm run build:host && npm run instrument:apply && npm run verify:production
)
```

Do not delete recovery state to resolve a failed cleanup. Inspect conflicts and use the recovery guidance instead.

## Generated output

Playwright writes screenshots, JSON diagnostics, stderr, traces, and failure artifacts under **`test-results/<suite>/`**. Test-owned files use `testInfo.outputPath()` so they get a test-specific directory and do not depend on checked-in artifact folders. The workspace capture tests share their Electron session and capture folder within the test file. Each suite refreshes its own output; other suites' output is left alone. The package suite records the tested AppImage digest/runtime/cycles. Failed package projects and recovery journals are retained in a temporary directory identified by `recovery-location.txt`; inspect before removing them. The workspace HTML report goes in **`playwright-report/`**.

Both folders are ignored and disposable when no test is running. Do not commit generated output or recreate per-issue evidence folders. For a release or bug report that needs retained artifacts, attach the relevant files to that release/issue or store them outside the repository. Historical committed reports remain available through Git history.

`.mauxi-*-state/` folders are different: they may contain unfinished recovery journals and are not ordinary disposable test reports. Build outputs (`dist/`, `dist-electron/`, `release/`) are ignored separately.

## Release gate

See the [acceptance table](alpha-acceptance.md) and [candidate usage notes](private-alpha.md). `npm run check` remains the fast deterministic owner-test suite, not release certification. Release gates and package checks assert actual required behavior; missing real-project/live-provider evidence still blocks acceptance even when these suites pass. Build packaging uses pinned `electron-builder` 26.15.3 with `--publish never`. This includes the AppImage runtime search-path fix described in [GHSA-7g7r-gx96-252g](https://github.com/electron-userland/electron-builder/security/advisories/GHSA-7g7r-gx96-252g). `MAUXI_APPIMAGE=/absolute/path` can select a candidate for `test:package-e2e`; otherwise it tests `release/Mauxi-0.1.0-x86_64.AppImage`. Rebuild before claiming evidence for source changes.

## What these checks do not establish

Local fake providers keep unit tests deterministic and free of paid model calls. Passing them does not establish live subscription/API compatibility, real-model design quality, human acceptance, real-device behavior, or full authenticated AppImage acceptance. Live provider testing must be explicitly authorized and cost-bounded. Avoid maintaining frozen pass counts in documentation; run the relevant commands for current results.
