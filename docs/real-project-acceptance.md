# Real-project acceptance run

The founder nominated Rondo (Vite) and nenazo-nicho (Next.js) and authorized `openai-codex` / `gpt-6-luna` through the existing ChatGPT OAuth login. The run executed on 2026-10-15. **Human design-quality assessment is still missing**, so AC-19 is incomplete. Do not publish project contents, credentials, session bodies or screenshots.

## How it runs

`npm run test:live-acceptance` drives the packaged AppImage through [the live spec](../tests/live-acceptance/real-project.spec.ts). It is skipped unless `MAUXI_LIVE_PLAN` names a private plan file listing provider, model, the source `auth.json`, an evidence directory, and per-project paths, selectors and prompts. It never runs in default suites.

For each disposable project copy it:

1. Starts the AppImage with an isolated HOME, external Node/npm and no `pi` on PATH; opens the project and confirms launch; selects the model.
2. For each task, picks the declared desktop/mobile elements, hands preview control to the agent, sends the prompt, approves only `Approve browser action` dialogs, denies every other approval and cancels agent questions, then records the response, approvals and an external Git diff committed per task.
3. Closes and reopens twice, quits and restarts the app, and checks credentials, retained edits, owned processes and integration artifacts.

Evidence (report JSON, screenshots, diffs, session logs) stays outside Git in the plan's evidence directory.

## 2026-10-15 result

AppImage SHA-256 `39d2dd6ac548184271fa00101e84df906a25bb883469d511d36f49ebb2da53ee`. Linux Mint 22.3 / X11 / x86_64, external Node 22.23.1 / npm 10.9.8. Usage over all attempts: 261 model calls, about 0.7M input (plus 10M cached) and 25k output tokens, roughly $0.18 at catalog list price, billed to the ChatGPT subscription rather than per request.

| Project | Responsive refinement | Component polish | Animation / reduced motion | Visible checks + external diff | Human assessment | Auth / spend receipt |
| --- | --- | --- | --- | --- | --- | --- |
| Rondo — React 19, Vite 8.2 | Edited; desktop + mobile captured | Edited; desktop captured, mobile capture hit a reloaded document | CSS stagger edited; existing reduced-motion rule kept; desktop captured, mobile hit a reloaded document | Diffs recorded per task | Missing | Reused OAuth; private receipt |
| nenazo-nicho — React 19, Next 16.3 (default Turbopack dev) | Edited; desktop + mobile inspected and captured | Edited; desktop + mobile inspected and captured | Motion drag edited with a reduced-motion branch; captured both, drag not dispatched | Diffs recorded per task | Missing | Reused OAuth; private receipt |

Both projects completed two close/reopen cycles with both bridges ready, a restart with credentials intact, and final cleanup with no owned processes or integration artifacts. Next rewrites its own `next-env.d.ts` on restart; that file is not a Mauxi artifact.

### Defects found and fixed during the run

- Selections attached before **Give agent control** went stale on send because revalidation replies were dropped while the agent held control.
- `browser_targets` required a workspace ID the model is never given.
- The agent host captured the setup window's browser control and reported "Visible window unavailable" after the workspace window replaced it.
- `workspace_search` failed on a single-file `path`, which also revoked preview control.
- The 16-turn run budget stopped ordinary tasks before verification; the founder approved 40 turns.

Regression coverage: [selection handoff](../tests/browser-e2e/selection-handoff.spec.ts) and the updated [package gate](../tests/package-e2e/private-alpha.spec.ts).

### Known limits observed

- Any failed browser action, including a preview that reloaded after an edit, returns control to the user; the agent must ask for a new handoff.
- Navigation, including in-page anchors, invalidates control by design.
- Browser tools cannot dispatch drags or toggle `prefers-reduced-motion`; motion behavior still needs a human check.
- A budget stop surfaces as "This operation was aborted" instead of naming the budget.

When the founder has assessed each result and recorded tester-delivery approval, update the [acceptance gate](alpha-acceptance.md). Until then the AppImage is a validation candidate. No public release is authorized.
