# Agent conversations and responsive accessibility guidance

## Providers and conversations

Open **Models & providers** in chat to authenticate and select a model and supported reasoning level. Provider-owned text, secret, device-code, and manual-code steps appear inside the expanded chatbox. Cancelling is never approval. Authentication links are limited to exact HTTPS URLs from the active provider flow. Catalog refresh retains cached models if it fails.

Mauxi ships its pinned agent SDK as a production dependency; there is no separate CLI or agent service to install. The host owns one agent runtime for the active workspace. New/resumed conversations do not restart the project server. Closing the workspace disposes the agent before project cleanup.

Credentials, model configuration, and native conversation sessions live under `<Mauxi userData>/pi-profile`, separate from the terminal's `~/.pi/agent` profile. Mauxi does not automatically import terminal credentials or configuration. Credentials are not placed in chat or preview storage.

The minimal chat supports Stop, queued follow-up, and structured questions. New/resume/rename and managed undo remain trusted-host capabilities, not renderer controls or IPC endpoints. Native sessions are retained, but there is no history picker. Host-level resuming restores conversation history, **not source files**. Rejected preflight keeps the unsent draft and attachments; text-only models reject visual attachments. Captured selection PNGs must come from Mauxi's capture directory and are capped at 10 MiB.

Normal chat shows a short working phrase followed by final text, not intermediate reasoning or successful tool narration. Stop, queued messages, questions, approvals, and errors remain accessible. There is no tool-activity or changed-file review panel. Tool results and checkpoint diagnostics remain available to trusted host integrations and native history; the agent must report failures honestly. Renderer snapshots omit historical session lists, tool payloads, and change-set diffs instead of recomputing/broadcasting unused data.

## Project tools and trust

Only host-defined tools are exposed:

| Tool | Purpose |
| --- | --- |
| `workspace_read`, `workspace_list`, `workspace_search` | Bounded, project-confined reads |
| `workspace_edit`, `workspace_write`, `workspace_delete` | Managed, checkpointed source changes |
| `workspace_command` | One command per exact, one-time approval |
| `ask_question` | Structured questions to the user |
| `responsive_audit` | Re-runs the [responsive audit](audit.md) in the hidden audit window |
| `browser_targets`, `browser_action` | Checks of the visible previews after an explicit handoff |

Project text and DOM content are untrusted input, not permission.

Project/global resource discovery and executable extensions are disabled. The app does not silently load packages, TUI factories, project context files, or a terminal configuration. These are application-level boundaries for trusted local projects, **not an OS sandbox**. See [changes and recovery](changes-and-recovery.md) for command, filesystem, and undo limits and the [workspace guide](workspace.md) for preview control.

## Responsive accessibility guidance

The agent works under a fixed host policy focused on responsive accessibility: the WCAG 2.2 criteria that depend on the viewport (1.4.10 Reflow, 1.4.4 Resize text, 1.4.12 Text spacing, 2.5.8 Target size, 2.4.11 Focus not obscured, 1.3.4 Orientation). It prefers intrinsic, fluid fixes that hold across the whole width range over breakpoint-specific patches, keeps intentional horizontal scrollers (carousels, tables, code blocks) scrollable, and preserves the project's framework, tokens, brand and conventions. It never claims full WCAG conformance.

There are no bundled design skills, visual reference libraries, or design tools. Audit findings attached with **Fix with agent** are deterministic DOM measurements sent as a compact text description (criterion, width ranges, element, source, measurement and fix direction; no snapshots). The agent treats them as evidence but reads the source before changing it. Missing browser capabilities or packages do not grant permission to install or simulate them.

### `responsive_audit`

- `route` (optional, a path starting with `/`) audits one route. Without it, the tool audits the route last audited (or opened from **All pages**) in this workspace, or `/`. The result lists up to 30 findings in the same compact form, the findings resolved since the previous run of that route, intentional scrollers and the interaction pass counts with up to eight notes.
- `routes` (1–12 paths) runs a site audit in one call instead. Each route goes through the [discovery link policy](audit.md#what-discovery-leaves-out-and-why): one authentication, API, action or callback route refuses the whole batch before anything loads, hashes are dropped and duplicates removed. It returns each page's status, counts, bug widths, resolved count and any error, not the findings themselves.
- At most four audits per run; a batch counts as one. Only one audit runs at a time: a call made while a single-route audit is running (such as the one the canvas starts when it opens) waits for it to finish, up to three minutes; a call made during a site audit is refused.
- It needs no approval or preview handoff, never touches the visible previews, and every run updates the panel like a run started there (a batch opens the **All pages** summary).

The host policy tells the agent to confirm a fix with `responsive_audit` on the same route and to use `routes` when a fix touches layout shared by several pages.

Automated fake-provider tests cover tool availability, quiet chat, capability checks, and safety boundaries—not real-model fix quality or live authentication compatibility. Human assessment remains necessary.
