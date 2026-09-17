# G1 project lifecycle

Mauxi now opens one local React + Vite or supported Next.js project at a time. Discovery reads `package.json`, lockfiles, workspace declarations, scripts, and Git status without importing or evaluating project configuration. The confirmation screen shows the canonical app root, framework, package manager, exact saved development command, preview origin, and the temporary integration diff.

## Launch and cleanup flow

1. Choose **Open project…** and select a project directory.
2. Review the detected plan. If a monorepo or manifest exposes several supported plans, choose the intended app and script.
3. Resolve missing dependencies yourself. Mauxi never runs an install.
4. Choose **Confirm & start** to let Mauxi own one development process, or **Attach to existing** for an explicitly user-owned server already listening on the shown port.
5. Wait for the HTTP readiness check and both preview-bridge handshakes. HTTP alone is not considered ready.
6. Choose **Close project** or quit Mauxi. It stops only a process group it started, leaves attached servers running, removes only its marked hook and unchanged owned bridge/client artifacts, and records conflicts instead of restoring whole files.

Setup writes an atomic recovery journal under the private Electron user-data directory before changing the project. On next launch, unfinished setup or cleanup is retried before another project can be prepared. Cleanup is idempotent. A changed owned artifact, missing patched file, symlink replacement, or modified owned region is preserved and surfaced as a recovery conflict. Existing dirty/untracked work and the Git index are not reset, stashed, cleaned, or committed.

Saved setup is used only to preselect a later confirmation. Mauxi does not automatically rerun the saved command on launch. Preview browser storage uses a persistent Electron partition derived from the canonical workspace root, so different workspaces do not share cookies or local storage.

## Supported setup boundary

- React + Vite with one unambiguous static `plugins` array in `vite.config.ts`, `.mts`, `.js`, or `.mjs`.
- Next.js 15.3 or newer using its `instrumentation-client` convention. Mauxi does not parse or rewrite `next.config`; named, direct, wrapped, CommonJS, TypeScript, existing-Webpack, Webpack, and Turbopack configurations use the same client hook. Existing instrumentation clients receive one marked development-only import; otherwise Mauxi creates an owned temporary client file.
- npm, pnpm, and Yarn launch scripts; dependencies must already exist. The packaged app resolves managers from `PATH` plus common Linux user installs for nvm, fnm, Volta, asdf, and pnpm without executing shell profiles.
- Loopback HTTP origins and one active app root.

Unsupported or ambiguous config shapes are reported before mutation. Mauxi does not execute a config to infer it, guess a backend, take over an occupied port, or silently restart an attached server. When attachment adds a hook to a config already loaded by the external server, the UI asks the user to restart that server themselves and waits for the bridge.

Recovery storage permits at most 64 unfinished valid journals before blocking a new setup. Unfinished recovery data is never evicted automatically. Runtime logs are bounded to 400 lines of 4,000 characters each.

## Linux artifact

The first private-alpha artifact is **AppImage**:

```bash
npm run dist:linux
./release/Mauxi-0.1.0-x86_64.AppImage
```

Built and smoke-tested on Linux `7.0.0-31-generic` x86_64 with Node `22.23.1`, npm `10.9.8`, Electron `44.4.1`, and Chromium `152.0.7977.78`. The smoke check launched the actual AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` (avoiding a host FUSE dependency), discovered the Next.js fixture, resolved its external npm toolchain, started it, connected both previews, then closed with `next.config` unchanged and all temporary client artifacts removed. Full authenticated packaged acceptance remains release work.

## Checks

```bash
npm run check
npm run test:e2e
npm run test:lifecycle-e2e
npm run test:turbopack-e2e
npm run verify:production
npm run dist:linux
```

Unit coverage includes static discovery without config execution, ambiguous workspace roots, occupied unrelated ports, forged source paths, durable instrumentation recovery, concurrent config edits, changed-artifact conflicts, varied Next.js config shapes, and existing instrumentation clients. Electron E2E coverage retains the G0 two-preview checks and separately verifies the bridge under Next.js Turbopack without modifying `next.config`.
