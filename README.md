# Mauxi

A minimal, local-first **Linux** desktop workspace for polishing, building, and animating real web interfaces with a pi-powered coding agent.

Open a local project, explore live desktop and mobile previews on a freeform canvas, select precise elements, and discuss changes that update the real source code.

This repository is Linux-only. The macOS and Windows products use different stacks and repositories; portability work is outside this project's scope.

## Project status

**G3 live changes are complete ([issue #6](https://github.com/MatiasGigena/Mauxi/issues/6)).** Trusted projects now expose host-checked edit/write/delete tools and exact, one-time command approval. Request checkpoints preserve the actual dirty baseline outside Git, serialize mutations, retain partial failures, show attributable changed files and diffs, report bounded command observations without claiming provenance or automatic undo, and provide idle-only conflict-safe undo for eligible managed changes without touching unrelated work or the Git index. Linux mutations use a bounded, app-owned recovery vault outside the repository rather than clobber concurrent arrivals. Cross-filesystem mutations fail closed, retained recovery pins its review records, and cleanup requires manual review; see the live-change documentation. Instrumentation cleanup remains separate from design undo.

**G3 resumable pi conversation is complete ([issue #5](https://github.com/MatiasGigena/Mauxi/issues/5)).** Mauxi bundles the pinned pi SDK, keeps provider credentials and pi-native sessions in an app-owned profile, exposes provider-owned setup/re-auth/logout and capability-aware model/thinking controls, and streams conversation and expandable tool activity without a terminal or separately installed CLI. New/resume/rename, Stop, steering, queued follow-up, structured questions, explicit auth/catalog/rate-limit/capability errors, and checked authentication links stay behind the anchored chat and temporary dialogs.

**G2 source-linked multi-selection is complete.** The real picker works across camera zoom and pan, nested scrolling, overlapping targets, SVG, portals, sticky/fixed UI, and child-frame boundaries without activating the page underneath. Keyboard refinement distinguishes DOM ancestry from React ownership. Desktop and mobile picks accumulate as inspectable, removable chat attachments with bounded/redacted context, verified JSX provenance and file fingerprints, correctly clipped screenshot crops, and explicit ambiguous, library, stale, or unsupported states.

Selections retain rendered-instance identity across safe list reorders and become stale after remounts, HMR/source changes, navigation, or document replacement. Every send revalidates and snapshots its attachments before the pi request; failed preflight keeps the draft and attachments, and text-only models explicitly reject captured image context.

**G2 minimal workspace is complete.** Two live previews support independent positioning, canvas pan and 25–200% zoom, fit/reset, focus without remounting, explicit viewport sizing and bounded route linking with unlink/copy controls. Chat stays anchored and resizable; secondary tools live in Actions. Layout persists through the existing workspace record.

**G1 project lifecycle is complete.** The Linux app can statically inspect a local project, show a launch and temporary-integration plan for confirmation, own or explicitly attach to a development server, connect the two proven previews, and perform journaled conflict-safe cleanup and next-launch recovery. The supported matrix covers React + Vite and Next.js 15.3+ with Webpack or Turbopack.

- [G3 live-change acceptance criteria](https://github.com/MatiasGigena/Mauxi/issues/6)
- [G3 checkpoints, approvals, review/undo, and deterministic evidence](docs/G3-LIVE-CHANGES.md)
- [G3 conversation acceptance criteria](https://github.com/MatiasGigena/Mauxi/issues/5)
- [G3 pi architecture, boundaries, and deterministic evidence](docs/G3-PI-CONVERSATION.md)
- [G2 source-linked selection issue and acceptance criteria](https://github.com/MatiasGigena/Mauxi/issues/4)
- [G2 selection behavior, provenance, crops and freshness](docs/G2-SELECTIONS.md)
- [G2 workspace acceptance issue](https://github.com/MatiasGigena/Mauxi/issues/3)
- [G2 controls, route boundaries, Linux walkthrough and test evidence](docs/G2-WORKSPACE.md)
- [G1 acceptance issue and evidence](https://github.com/MatiasGigena/Mauxi/issues/2)
- [G1 launch, cleanup, recovery, and AppImage flow](docs/G1-PROJECT-LIFECYCLE.md)
- [G0 proof, tested matrix, steps, and limitations](docs/G0-PROOF.md)
- [Product and technical specification](SPEC.md)
- [Original workspace concept](docs/assets/workspace-concept.png)

Verified: TypeScript, **123 unit tests** (including no-cost local fake providers), **14 Linux Electron workspace tests**, lifecycle close/reopen, Turbopack bridge, application build, AppImage packaging, and production bridge-exclusion checks. Live provider smoke testing remains opt-in and is not claimed from fake-provider evidence.

Run `npm run check`, `npm run build`, `npm run test:e2e`, `npm run test:lifecycle-e2e`, `npm run test:turbopack-e2e`, and `npm run verify:production`. Build the Linux private-alpha artifact with `npm run dist:linux`.

## Direction

- Simple layered architecture: **presentation → application → infrastructure**, in one application.
- Use **`/apple-design`** for a clear, restrained visual interface and direct, responsive interactions.
- Keep the canvas and chat central; avoid speculative frameworks, extra services, and permanent panels for secondary tools.

The implementation remains intentionally concrete: one Electron app, one active workspace, ordinary TypeScript modules, and no background cleanup service or cross-platform abstraction.
