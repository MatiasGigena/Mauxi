# Mauxi

A local-first **Linux** desktop workspace for polishing, building, and animating real web interfaces with a coding agent.

Open a local project, explore live desktop and mobile previews on a freeform canvas, select precise elements, and discuss changes that update the real source code.

## What it does

- Opens React + Vite and supported Next.js projects with an explicit launch plan and temporary preview integration.
- Keeps desktop and mobile previews live while you pan, zoom, focus, resize, and select elements linked to their source.
- Offers resumable agent conversations and provider/model setup, with a host policy focused on responsive accessibility fixes.
- Applies live edits with retained checkpoints, conflict-aware recovery, and one-time command approval.
- Lets the agent inspect the same visible previews after an explicit handoff from chat, with separate approvals for interactions and checks retained in session history.

Mauxi is a **private-alpha validation candidate**, not yet accepted for tester rollout and not a general-purpose browser or OS sandbox. Use trusted projects and development accounts. The [acceptance gate](docs/alpha-acceptance.md) defines the required checks, validation scope and remaining blockers. macOS and Windows are outside this repository's scope.

## Run locally

Use Node.js 22 and npm on Linux, with a graphical desktop:

```bash
npm ci
npm run dev
```

Open a project with its dependencies already installed, review the proposed setup, and choose **Confirm & start**. Mauxi starts its own server without taking over one already running. Configure a provider and model through **Models & providers** in chat; a separate agent CLI is not required.

## Build an AppImage

```bash
npm run dist:linux
```

The artifact is written to `release/`. If FUSE is unavailable, launch the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1`.

## Documentation

- [Workspace, project setup, and preview controls](docs/workspace.md)
- [Agent conversations and responsive accessibility guidance](docs/agent.md)
- [Changes, command approval, undo, and recovery](docs/changes-and-recovery.md)
- [Private-alpha setup, privacy, limits, and recovery](docs/private-alpha.md)
- [AC-01–AC-21 acceptance gate and blockers](docs/alpha-acceptance.md)
- [Development and automated checks](docs/development.md)

The application uses one simple layered architecture: **presentation → application → infrastructure**. Automated tests and their fixtures stay in the repository; generated screenshots, logs, traces, and reports do not.
