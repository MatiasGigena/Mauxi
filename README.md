# Mauxi

A minimal, local-first **Linux** desktop workspace for polishing, building, and animating real web interfaces with a pi-powered coding agent.

Open a local project, explore live desktop and mobile previews on a freeform canvas, select precise elements, and discuss changes that update the real source code.

This repository is Linux-only. The macOS and Windows products use different stacks and repositories; portability work is outside this project's scope.

## Project status

**Specification draft — no application implementation yet.**

- [Product and technical specification](SPEC.md)
- [Original workspace concept](docs/assets/workspace-concept.png)

## Direction

- Simple layered architecture: **presentation → application → infrastructure**, in one application.
- Use **`/apple-design`** for a clear, restrained visual interface and direct, responsive interactions.
- Keep the canvas and chat central; avoid speculative frameworks, extra services, and permanent panels for secondary tools.

The next step is to review the specification and then break it into a few feature-sized implementation issues. The specification distinguishes agreed decisions from proposed defaults and unresolved technical risks.
