# Agent conversations and background design guidance

## Providers and conversations

Open **Models & providers** in chat to authenticate and select a model and supported reasoning level. Provider-owned text, secret, device-code, and manual-code steps appear inside the expanded chatbox. Cancelling is never approval. Authentication links are limited to exact HTTPS URLs from the active provider flow. Catalog refresh retains cached models if it fails.

Mauxi ships its pinned agent SDK as a production dependency; there is no separate CLI or agent service to install. The host owns one agent runtime for the active workspace. New/resumed conversations do not restart the project server. Closing the workspace disposes the agent before project cleanup.

Credentials, model configuration, approved personal resources, and native conversation sessions live under `<Mauxi userData>/pi-profile`, separate from the terminal's `~/.pi/agent` profile. Mauxi does not automatically import terminal credentials or configuration. Credentials are not placed in chat or preview storage.

Conversations support new, resume, rename, Stop, steering, queued follow-up, and structured questions. Resuming restores conversation history, **not source files**. Rejected preflight keeps the unsent draft and attachments; text-only models reject visual attachments. Captured selection PNGs must come from Mauxi's capture directory and are capped at 10 MiB.

Normal chat shows a short working phrase followed by final text, not intermediate reasoning or successful tool narration. Stop, queued messages, questions, approvals, errors, and changed-file review remain accessible. Failed workspace operations have bounded expandable diagnostics; native session history is still persisted internally.

## Project tools and trust

Only host-defined tools are exposed: bounded project read/list/search, managed edit/write/delete, exact-command approval, structured questions, background design resources, and explicit visible-preview control. Project text and DOM content are untrusted input, not permission.

Project/global resource discovery and executable extensions are disabled. The app does not silently load packages, TUI factories, project context files, or a terminal configuration. These are application-level boundaries for trusted local projects, **not an OS sandbox**. See [changes and recovery](changes-and-recovery.md) for command, filesystem, and undo limits and the [workspace guide](workspace.md) for preview control.

## Background design guidance

Design guidance remains part of the agent, not a user-facing mode. There is no design-direction panel, resource picker, toggle, or activation announcement. Requests automatically receive applicable previously approved skill bodies and their reviewed Markdown dependencies; the model can refine its selection through `design_read`.

The supported personal skills remain `apple-design` (interface craft), `mobile-native` (responsive/touch work), `emil-design-eng` (motion/polish), and `prototype` (isolated alternatives). Existing enabled, hash-verified copies under `<Mauxi userData>/pi-profile/design-resources/` continue loading. Personal skills are not bundled or silently imported from terminal profiles, and no redistribution license is assumed. Missing or modified copies are not loaded. Internal host import operations still require explicit approval; they have no renderer-facing API or controls.

The repository visual library at `design-references/library/catalog.json` is available automatically on a fresh profile. Packaged builds copy the catalog and images to `<resources>/design-references/library/`, outside the ASAR for verified filesystem reads. No import or setup UI is required. An existing approved catalog takes precedence, including its disabled state; corrupt private configuration fails closed rather than silently replacing it.

The agent can:

- `design_read`: read enabled, hash-verified skill Markdown and declared linked Markdown dependencies.
- `design_search`: retrieve up to five matching reviewed references by family, tags, and textual cues.
- `design_image`: inspect verified local WebP images by result ID and viewport, at most two per run. Text-only models receive an explicit capability error.

All original references remain in the repository, including `design-references/directions/`. Only catalog entries marked reviewed participate in retrieval (currently 10); candidates and unindexed images are not automatically promoted. Searches may legitimately return no match. The review label is supplied by the catalog author, not a quality certification. There is no network retrieval or copying of reference assets into target projects. Inspected references and loaded guidance may be sent to the selected model provider.

Before every send, including steering/follow-up, common English and some Spanish request terms select applicable enabled skills. Selected skill bodies and dependencies are attached once per file and revalidated by digest. The combined UTF-8 budget is 300,000 bytes; oversized guidance fails before sending. This is not a universal semantic classifier.

Guidance preserves project conventions, brand, accessibility and reduced motion. It asks for missing decisions, keeps variants isolated, and requires actual checks rather than claims based on tool intent. Guidance injection, reference tool activity, and intermediate activation narration stay out of normal chat; errors, approvals, and uncertainty remain visible. Missing skills, browser capabilities or packages do not grant permission to install or simulate them.

Configuration persists in `resources.json` under the private resource directory. Back it up before maintenance. Disabled resources stay disabled, and disabling cannot erase earlier conversation context; start a new conversation to remove it. Modified approved catalogs require explicit reapproval, not silent replacement.

Automated fake-provider tests cover background loading, tool availability, verified image delivery, quiet chat, capability checks, and safety boundaries—not real-model design quality or live authentication compatibility. Human assessment remains necessary.
