# Mauxi

A minimal, local-first **Linux** desktop workspace for polishing, building, and animating real web interfaces with a pi-powered coding agent.

Open a local project, explore live desktop and mobile previews on a freeform canvas, select precise elements, and discuss changes that update the real source code.

This repository is Linux-only. The macOS and Windows products use different stacks and repositories; portability work is outside this project's scope.

## Project status

**G2 minimal workspace is complete.** Two live previews support independent positioning, canvas pan and 25–200% zoom, fit/reset, focus without remounting, explicit viewport sizing and bounded route linking with unlink/copy controls. Chat stays anchored and resizable; secondary tools live in Actions. Layout persists through the existing workspace record.

The P2 review findings are addressed: native form submissions are not mirrored, independent route linking resumes afterward, and SPA navigation invalidates that preview’s selection attachments. Regression coverage passes alongside the original preview and lifecycle tests. Chat remains a labelled local demo; the full selector, model integration and checked external opening are not yet implemented.

**G1 project lifecycle is complete.** The Linux app can statically inspect a local project, show a launch and temporary-integration plan for confirmation, own or explicitly attach to a development server, connect the two proven previews, and perform journaled conflict-safe cleanup and next-launch recovery. The supported matrix covers React + Vite and Next.js 15.3+ with Webpack or Turbopack.

- [G2 acceptance issue](https://github.com/MatiasGigena/Mauxi/issues/3)
- [G2 controls, route boundaries, Linux walkthrough and test evidence](docs/G2-WORKSPACE.md)
- [G1 acceptance issue and evidence](https://github.com/MatiasGigena/Mauxi/issues/2)
- [G1 launch, cleanup, recovery, and AppImage flow](docs/G1-PROJECT-LIFECYCLE.md)
- [G0 proof, tested matrix, steps, and limitations](docs/G0-PROOF.md)
- [Product and technical specification](SPEC.md)
- [Original workspace concept](docs/assets/workspace-concept.png)

Verified: TypeScript, **43 unit tests**, **13 Linux Electron workspace tests**, lifecycle close/reopen, Turbopack bridge, application build and production bridge-exclusion checks.

Run `npm run check`, `npm run build`, `npm run test:e2e`, `npm run test:lifecycle-e2e`, `npm run test:turbopack-e2e`, and `npm run verify:production`. Build the Linux private-alpha artifact with `npm run dist:linux`.

## Direction

- Simple layered architecture: **presentation → application → infrastructure**, in one application.
- Use **`/apple-design`** for a clear, restrained visual interface and direct, responsive interactions.
- Keep the canvas and chat central; avoid speculative frameworks, extra services, and permanent panels for secondary tools.

The implementation remains intentionally concrete: one Electron app, one active workspace, ordinary TypeScript modules, and no background cleanup service or cross-platform abstraction.
