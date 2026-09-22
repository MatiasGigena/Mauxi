# G3 · Local design guidance (issue #7)

## Approved initial pack

The founder approved **local-only imports** of these four existing personal skills. They are not redistributed in Mauxi's bundle:

| Skill | Automatic use | Known limits |
| --- | --- | --- |
| `apple-design` | Interface/layout craft | Preserve target tokens and brand; Apple styling is not mandatory. |
| `mobile-native` | Mobile, responsive and touch work | Hardware behaviors cannot be verified by desktop emulation. Its optional sibling skills are not bundled. |
| `emil-design-eng` | Polish, animation, gestures, reduced motion | Browser/slow-motion checks still require appropriate tools. |
| `prototype` | Variants and alternatives | Imports its linked `PICKER.md`; keep experiments isolated and await the user's choice. |

The source frontmatter does not declare redistribution licenses. Approval is not a license grant. `evidence/issue-7/pack-audit.json` records the inspected originals' hashes and confirms that their manual-only flags remain present. Only Mauxi's private copies omit `disable-model-invocation`; the prototype copy also replaces its contradictory manual-only description. No executable files, packages, sibling skill trees or terminal configuration are copied.

## Setup and control

1. Open a project and the existing model/settings button in chat.
2. Expand **Design guidance**, select **Import skill…**, and choose one of the four `SKILL.md` files. Review the displayed path/version and trust warnings, then approve once. Repeat for the desired pack.
3. Select **Choose visual library…** and choose `design-references/library/catalog.json`. This is an explicit local path, not an asset bundled into the app.
4. Enable/disable individual entries. **Use once** fills `/skill:name ` in the composer; it never sends automatically. `/name` also works. Disabled or unavailable explicit invocations fail before a checkpoint or model request.

Resource setup is idle-only. Sources, hashes, state and failures are visible only in the temporary settings sheet. A resource already included in conversation history cannot be unlearned: disable it and start a new conversation to remove that context. This is intentionally not a marketplace or package dashboard.

Application-owned configuration is `<Mauxi userData>/pi-profile/design-resources/resources.json`. Imported Markdown is stored under content-versioned skill directories there. Configuration replacement is atomic. Corrupt configuration blocks new imports until repaired rather than silently overwriting it. Missing/modified copies are not loaded. To replace a previously imported skill version, stop Mauxi, back up the app-owned resource configuration, remove that skill's entry from `resources.json`, restart and explicitly reimport it; there is no silent update mechanism.

## Workflow and evidence boundary

The host classifies common request language before **every** send, including steering/follow-up. It attaches the actual complete matching enabled skill bodies and all their imported Markdown dependencies (including transitive links), not just descriptions or filenames. Each file is attached once with its skill name and relative path, and its digest is revalidated at send time. The entire guidance block has a 300,000-byte UTF-8 budget across selected skills; oversized guidance fails before sending rather than silently dropping required instructions. Native pi parsing/discovery (`loadSkills`, with defaults off) and `skillsOverride` supply normal skill metadata. A bounded `design_read` tool lets the model refine classification and read approved linked Markdown. Automatic selection supports common English terms and a few Spanish terms; it is not a universal semantic classifier.

Host-owned tools:

- `design_read`: only enabled, hash-verified imported Markdown and declared Markdown dependencies.
- `design_search`: up to five matching reviewed catalog entries, ranked by family, tags and textual cue. Explicit families constrain matching; a missing pricing family does not become an unrelated light-colored hero.
- `design_image`: verified local WebP bytes, by result ID and viewport, with a two-image limit per run and an explicit capability error for text-only models.

The current 172-entry catalog contains **10 reviewed entries and 162 candidates**. Candidates and uncatalogued `directions/` images are excluded rather than silently treated as reviewed material. Searches can legitimately return no match. Catalog changes require reapproval. The ten-entry count describes the current approved catalog, not a permanent hard-coded allowlist: users may explicitly approve a replacement catalog. A `reviewed` label is supplied by that trusted catalog's author, not an independent visual-quality certification by Mauxi. Relabeling an existing candidate cannot activate it without approval of the changed catalog digest. Missing images, changed digests, path traversal, final symlinks, out-of-root dependencies, malformed catalogs and oversized resources fail closed. Image/text reads are bounded; no network fetch or target-project asset copying occurs.

Workflow policy requires preserving project conventions, honoring accessibility/reduced motion, keeping variant exploration separate, asking missing decisions through the desktop bridge, and reporting actual checks rather than promising quality. Native skill instructions referencing read/bash are mapped to approved host tools. Missing browser tools, hardware, dependencies or sibling skills must be reported, not installed or simulated without permission.

## Trust boundary

The SDK uses in-memory settings with resource discovery disabled, including context files; an allowlisted skills override is the only skill source. This matters because pi package resolution occurs **before** `noExtensions` is applied. Project/global packages and executable extensions cannot silently enter through settings. Project context is inspected with bounded workspace tools instead.

Executable extensions, TUI factories and package imports are explicitly unsupported in this initial pack. They are rejected with an explanation before any execution. No universal desktop-extension compatibility is claimed. Compatible structured questions use the existing `ask_question` desktop dialog; cancellation or a missing connected UI is never consent. Resource import has its own one-time approval; it does not authorize commands or dependency installs. Existing exact-command approval and checkpoint/undo policy remain in force. These are trusted local application boundaries, not an OS sandbox.

## Quiet presentation

Normal chat does not render reasoning, intermediate assistant/tool-call narration or successful tool activity. It presents one short supplied working phrase (for example, `Tinkering...`) until final text is available. Stop, queued messages, structured questions, approval dialogs, errors and change review remain visible. Failed workspace operations retain expandable diagnostics; internal guidance failures direct the user to settings. The SDK still streams and persists native session history internally.

Settings and structured dialogs receive/trap keyboard focus and restore it on dismissal. Reduced-motion disables smooth transcript scrolling. No timed spinner/transition or extra permanent workspace panel was added.

## Verification

See `evidence/issue-7/verification.md` for the actual result matrix. Loader/fake-provider tests are deterministic evidence, not design-quality evaluations. The founder allowed a maximum of **four short live model requests**; all four were used without edits, so improved target-project output is **not verified**. Chromium shell checks pass; a native Electron test is retained but currently blocked by a startup failure reproduced on the unchanged baseline.
