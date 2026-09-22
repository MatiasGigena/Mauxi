# Mauxi

A local-first **Linux** desktop workspace for polishing, building, and animating real web interfaces with a coding agent.

Open a local project, explore live desktop and mobile previews on a freeform canvas, select precise elements, and discuss changes that update the real source code.

## What it does

- Opens React + Vite and supported Next.js projects with an explicit launch plan and temporary preview integration.
- Keeps desktop and mobile previews live while you pan, zoom, focus, resize, and select elements linked to their source.
- Offers resumable agent conversations, provider/model setup, and optional local design guidance.
- Applies live edits with checkpoints, changed-file review, eligible undo, and one-time command approval.
- Lets the agent inspect the same visible previews after an explicit handoff, with separate approvals for interactions and recorded checks.

Mauxi is a **private alpha**, not a general-purpose browser or OS sandbox. Use trusted projects and development accounts. Real-model design quality, human acceptance, and full authenticated packaged acceptance remain unverified. macOS and Windows are outside this repository's scope.

## Run locally

Use Node.js 22 and npm on Linux, with a graphical desktop:

```bash
npm ci
npm run dev
```

Open a project with its dependencies already installed, review the proposed setup, and confirm launch or explicitly attach to an existing server. Configure a provider and model through **Models & providers** in chat; a separate agent CLI is not required.

## Build an AppImage

```bash
npm run dist:linux
```

The artifact is written to `release/`. If FUSE is unavailable, launch the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1`.

## Documentation

- [Workspace, project setup, and preview controls](docs/workspace.md)
- [Agent conversations and local design guidance](docs/agent.md)
- [Changes, command approval, undo, and recovery](docs/changes-and-recovery.md)
- [Development and automated checks](docs/development.md)
- [Original product requirements](SPEC.md) — planning reference, not current implementation status

The application uses one simple layered architecture: **presentation → application → infrastructure**. Automated tests and their fixtures stay in the repository; generated screenshots, logs, traces, and reports do not.
