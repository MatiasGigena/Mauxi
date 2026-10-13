# Bundled design skills

Mauxi ships `apple-design`, `mobile-native`, `emil-design-eng`, and `prototype`, including prototype's linked `PICKER.md`. They are Markdown guidance, not executable extensions.

## Provenance

These are copies of the project owner's existing personal skills, supplied from the local Pi skills directory on 2026-10-13. The owner explicitly confirmed permission to bundle these copies with Mauxi. This records that authorization; it does not assert an upstream open-source license or endorsement by the people or organizations discussed in the guidance.

The originals are unchanged. Bundled copies remove `disable-model-invocation: true`; prototype's description permits automatic invocation for variant requests. Other content, including the picker instructions, is preserved. Host safety, explicit user requests, and target-project conventions take precedence over skill examples and suggested workflows.

## Loading and updates

Electron supplies the absolute `design-skills/` resource directory in development and packaged builds. Only the files indexed in `src/infrastructure/agent/bundled-design-skills.ts` can be read as skill guidance; their SHA-256 hashes are pinned in the host bundle and checked at load time and before sending. No terminal-profile discovery or runtime download occurs.

When deliberately updating bundled Markdown, review the content and dependencies, then update its file digests and aggregate digest in that index. The aggregate is SHA-256 of a compact JSON object mapping sorted file names to their digests. Never regenerate hashes at runtime to accept changed content automatically. Run the design-resource and design-workflow tests after updates.

Approved personal copies override bundled copies by name, even if disabled or invalid. Built-in enablement is stored separately in the private profile, so an application update cannot silently re-enable a disabled skill. A corrupt private configuration fails closed.
