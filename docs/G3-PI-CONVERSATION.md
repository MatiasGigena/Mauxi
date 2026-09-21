# G3 · Pi authentication, models, and resumable chat

Issue: [#5](https://github.com/MatiasGigena/Mauxi/issues/5)

## Runtime boundary

Mauxi pins `@earendil-works/pi-coding-agent` `0.86.1` as an application dependency and bundles it into the Electron host. The renderer never imports the SDK and no pi CLI process or agent service is launched.

`PiAgentHost` owns exactly one `AgentSessionRuntime` for the active workspace. Its replacement callback detaches the old subscription before binding the new session. New and resumed conversations replace only this runtime; the `WorkspaceManager` and its development process remain alive. Closing the workspace disposes the agent before project cleanup.

The SDK uses `<userData>/pi-profile` for `auth.json`, `models.json`, the model catalog store, settings/resources, and pi-native JSONL sessions. It neither imports nor mutates the terminal profile at `~/.pi/agent`. Sessions are grouped by Mauxi workspace and have one host-process writer. Resuming restores conversation history only and explicitly does not restore source files.

## Provider and credential behavior

The Models & conversations sheet is temporary rather than a permanent panel. It derives providers, authentication methods, models, image support, and reasoning levels from `ModelRuntime`; there is no hard-coded provider catalog or universal login sequence.

Provider-owned text, secret, select, manual-code, browser, and device-code interactions are adapted to structured desktop dialogs. Cancelling rejects the pending interaction and cannot approve anything. Browser opening is limited to exact HTTPS URLs issued by the active SDK flow. Login, logout, re-authentication, and local catalog synchronization happen in the host. Renderer responses include only status/source labels and never credentials. Secret values are transient React/IPC values, redacted from bounded tool display, and never placed in chat or browser storage.

Catalog refresh has a 15-second deadline and retains cached models on failure. Authentication, catalog, rate-limit, image-capability, and runtime failures have distinct user-facing states.

## Conversation behavior

The bottom dock streams assistant text and read-only tool activity and distinguishes working, waiting for structured input, retrying, compacting, stopping, error, queued, and fully settled states. It supports:

- new, resume, and rename using pi-native sessions;
- Stop through SDK abort;
- steering after the current tool turn and queued follow-up after settlement;
- SDK preflight acceptance so rejected requests preserve the unsent draft;
- structured `ask_question` dialogs whose cancellation is reported as no answer;
- expandable, bounded tool input/output rather than terminal emulation.

Before send, Mauxi revalidates every selected target and its verified source fingerprint. The accepted request gets that exact snapshot; only those attachment IDs are then removed. Desktop/mobile labels, routes, bounds, source fingerprints, bounded DOM/styles, and screenshot availability enter one inspectable context block. Captured PNGs are loaded only from Mauxi's capture directory, are capped at 10 MiB, and are sent with SDK image content. A text-only model rejects visual attachments instead of silently acting as though it saw them.

## Read-only tool policy

Project extensions, executable imports, skills, prompts, and themes are disabled for this slice. The available tools are:

- `workspace_read` — bounded text reads;
- `workspace_list` — bounded directory listings;
- `workspace_search` — bounded literal search;
- `ask_question` — structured user input.

The filesystem tools canonicalize paths and reject anything outside the open project (including the Mauxi credential profile), skip symlinks during search, and expose no shell, edit, or write operation.

## Deterministic evidence

`tests/unit/agent-contract.test.ts` uses a local OpenAI-compatible fake provider and makes no paid calls. It covers:

- bundled SDK startup with an app-owned profile and idempotent initialization;
- provider login cancellation and re-authentication without credential reflection;
- token streaming and partial assistant state;
- a model tool call adapted to a structured desktop question;
- steering and queued follow-up;
- Stop/abort;
- rename, new session, resume, and preserved history;
- explicit text-only/image mismatch;
- bounded multi-selection context.

Validation run:

```text
npm run check     # TypeScript and 51 unit tests
npm run dist:linux
```

The AppImage build succeeds with the SDK bundled. No live provider authentication or paid model smoke test was run, so this evidence does not claim live subscription/API compatibility. That test remains explicitly opt-in and cost-bounded.
