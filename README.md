# Mauxi

A local-first **Linux** desktop workspace that audits how a real web app behaves at every viewport width and zoom level, and fixes what breaks in the project's own source.

Open a local project, run the **responsive audit**, and Mauxi sweeps the page from 320 to 1920 px plus phone, tablet, laptop, desktop, 400% zoom and text-spacing profiles. It reports horizontal overflow, content cut off, clipped text, small touch targets, sticky bars that cover the screen and zoom-blocking viewport tags, mapped to the WCAG 2.2 criteria that depend on the viewport. It also runs [axe-core](https://github.com/dequelabs/axe-core) contrast, name, label, ARIA and landmark rules at every width profile, so problems that exist only in the mobile (or only in the desktop) layout are reported with the widths where they occur. It tells deliberate carousels, tables and code blocks apart from accidental scrolling. Each finding comes with the widths where it happens, the element and its source file, and a fix direction you can hand to the agent.

## What it does

- Audits the route in the Desktop preview across a width sweep and full-check profiles without touching the visible previews, with snapshots of every profile on the canvas. See [responsive audit](docs/audit.md).
- Classifies findings as bugs, needs review or intentional patterns with accessibility gaps; resolved findings are tracked between runs.
- **Show at <width>** resizes a live preview to the failing width and outlines the element; **Fix with agent** attaches the finding to chat, and the agent verifies its fix with the same audit.
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

- [Responsive audit: checks, classification, limits](docs/audit.md)
- [Workspace, project setup, and preview controls](docs/workspace.md)
- [Agent conversations and responsive accessibility guidance](docs/agent.md)
- [Changes, command approval, undo, and recovery](docs/changes-and-recovery.md)
- [Private-alpha setup, privacy, limits, and recovery](docs/private-alpha.md)
- [AC-01–AC-25 acceptance gate and blockers](docs/alpha-acceptance.md)
- [Development and automated checks](docs/development.md)

The application uses one simple layered architecture: **presentation → application → infrastructure**. Automated tests and their fixtures stay in the repository; generated screenshots, logs, traces, and reports do not.
