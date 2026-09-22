# Agent conversations and design guidance

## Providers and conversations

Open **Models & providers** in chat to authenticate and select a model and supported reasoning level. Provider-owned text, secret, browser, device-code, and manual-code steps use temporary dialogs. Cancelling is never approval. Authentication links are limited to exact HTTPS URLs from the active provider flow. Catalog refresh retains cached models if it fails.

Mauxi ships its pinned agent SDK as a production dependency; there is no separate CLI or agent service to install. The host owns one agent runtime for the active workspace. New/resumed conversations do not restart the project server. Closing the workspace disposes the agent before project cleanup.

Credentials, model configuration, resources, and native conversation sessions live under `<Mauxi userData>/pi-profile`, separate from the terminal's `~/.pi/agent` profile. Mauxi does not automatically import terminal credentials or configuration. Credentials are not placed in chat or preview storage.

Conversations support new, resume, rename, Stop, steering, queued follow-up, and structured questions. Resuming restores conversation history, **not source files**. Rejected preflight keeps the unsent draft and attachments; text-only models reject visual attachments. Captured selection PNGs must come from Mauxi's capture directory and are capped at 10 MiB.

Normal chat shows a short working phrase followed by final text, not intermediate reasoning or successful tool narration. Stop, queued messages, questions, approvals, errors, and changed-file review remain accessible. Failed workspace operations have bounded expandable diagnostics; native session history is still persisted internally.

## Project tools and trust

Only host-defined tools are exposed: bounded project read/list/search, managed edit/write/delete, exact-command approval, structured questions, approved design resources, and explicit visible-preview control. Project text and DOM content are untrusted input, not permission.

Project/global resource discovery and executable extensions are disabled. The app does not silently load packages, TUI factories, project context files, or a terminal configuration. These are application-level boundaries for trusted local projects, **not an OS sandbox**. See [changes and recovery](changes-and-recovery.md) for command, filesystem, and undo limits and the [workspace guide](workspace.md) for preview control.

## Optional local design guidance

In agent settings, expand **Design guidance** and choose **Import skill…**. The current allowlisted local imports are:

| Skill | Intended use | Limits |
| --- | --- | --- |
| `apple-design` | Interface and layout craft | Preserve the project's brand and tokens; Apple styling is not mandatory. |
| `mobile-native` | Responsive, mobile, and touch work | Desktop emulation does not verify hardware behavior; sibling skills are not bundled. |
| `emil-design-eng` | Polish, motion, gestures, reduced motion | Browser and slow-motion checks still need appropriate tools. |
| `prototype` | Variants and alternatives | Includes linked Markdown guidance; keep experiments isolated and await the user's choice. |

Choose a local `SKILL.md`, inspect the source/version and trust warnings, and approve the import. The original is unchanged; private copies permit automatic use. These personal skills are **not bundled or licensed for redistribution** merely because a local import is approved. Executables, packages, terminal configuration, and unrelated sibling skill trees are not copied.

Enable/disable entries individually. **Use once** fills `/skill:name ` in the composer without sending; `/name` also works. Disabled or unavailable explicit invocations fail before a checkpoint or model request. Setup is idle-only. Disabling a skill cannot erase instructions already in conversation history: start a new conversation to remove that context.

Imported Markdown and configuration live under `<Mauxi userData>/pi-profile/design-resources/`. Missing/modified copies are not loaded, and corrupt configuration blocks imports rather than being silently replaced. To replace a version, stop Mauxi, back up `resources.json`, remove that skill's entry, restart, and explicitly reimport it. There is no automatic updater.

## Visual library

**Choose visual library…** explicitly approves a local catalog such as `design-references/library/catalog.json`, if available. The visual library is not bundled into the app. Catalog changes require reapproval; only entries marked reviewed in the approved catalog participate. That label is supplied by the catalog author, not a visual-quality certification by Mauxi. Candidates and uncatalogued images are excluded, and searches may return no match.

The agent can:

- `design_read`: read enabled, hash-verified skill Markdown and declared linked Markdown dependencies.
- `design_search`: retrieve up to five matching reviewed entries by family, tags, and textual cues.
- `design_image`: inspect verified local WebP images by result ID and viewport, at most two images per run. Text-only models receive an explicit capability error.

No network retrieval or target-project asset copying is performed. Modified resources, invalid catalogs, symlinks, escaping dependencies, missing images, and oversized resources fail closed.

## Guidance limits

Before every send, including steering/follow-up, common English and some Spanish request terms select applicable enabled guidance. Full selected skill bodies and imported Markdown dependencies are attached once per file and revalidated by digest. The combined UTF-8 budget is 300,000 bytes; oversized guidance fails before sending. This is not a universal semantic classifier, and the model may refine its selection through approved tools.

Guidance asks the model to preserve conventions, honor accessibility/reduced motion, keep variants isolated, ask for missing decisions, and report actual checks. Missing browser tools, hardware, dependencies, or sibling skills must be reported rather than installed or simulated without permission. Import approval never grants command or installation approval.

Automated fake-provider tests cover capability and safety behavior, not real-model design quality or live authentication compatibility. Human assessment on real projects and explicit live-provider acceptance are still needed; no quality guarantee is implied by loading guidance.
