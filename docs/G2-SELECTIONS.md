# G2 — Source-linked multi-selection

Implements issue #4 on the existing two-preview workspace. The picker remains a development-only bridge inside the approved project origin; project pages receive no Electron or filesystem API.

## Picker behavior

- Pointer hit testing happens in preview CSS pixels, independent of the 25–200% shell camera transform. The outline tracks layout movement, scrolling, fixed/sticky content, SVG DOM, portals, and nested scrolling.
- Selection capture suppresses pointer, mouse, touch, click, keyboard activation, context-menu, and submit paths. Every child frame receives a temporary interception shield because its events cannot bubble into the preview document. Picking attaches the iframe DOM element; cross-origin frame contents are explicitly unsupported.
- **Up/Down** refines the DOM child/parent path. **[ / ]** cycles overlapping paint targets. **Enter** attaches the refined target and **Escape** exits. The attachment inspector reports DOM ancestry separately from React ownership.
- Canvas/WebGL pixels and third-party child-frame contents are labelled unsupported. Pseudo-element pixels resolve only to their owning DOM element.

## Context and provenance

Each attachment has workspace, preview, selection and document-generation IDs; route, capture time, viewport and coordinate space; bounded/redacted text and DOM; selected styles; bounds; DOM ancestry; React owner/caller frames; and a document-scoped instance identity.

React Grab locations arrive as untrusted hints. The host canonicalizes them inside the application root, rejects escaping/symlink/ambiguous paths, derives coordinates only from an unambiguous JSX/tag-and-test-ID match, and returns a SHA-256 file fingerprint. Until that succeeds the UI says unverified or missing/ambiguous. Dependency paths are labelled library source and are not presented as application JSX.

Input, textarea, select and content-editable values are removed from text and serialized DOM context. Bridge records and arrays have schema/size limits. The shell replaces page-claimed fingerprints, verification state, workspace ID and screenshot status rather than trusting them.

## Crops and multiple attachments

Desktop and mobile picks accumulate as distinct, individually inspectable/removable chips; rendered instances are never deduplicated by source path. A crop is derived from the frame-local target bounds with bounded surrounding context, transformed through the actual iframe rectangle, and clipped to that iframe and the visible canvas. The picker overlay is hidden for capture. This excludes the other preview, artboard header, chat and shell controls. The inspector shows the resulting dimensions/path and warns that visible page pixels can still contain private information.

## Freshness

The bridge retains the exact selected DOM object under a generation-scoped random instance key. Reordering a retained keyed node can remain valid even if its positional selector changes; a remount or lookalike replacement cannot. Navigation and document replacement require another pick. Revalidation also checks the current route/generation and host-side source fingerprint. The fake send action runs this revalidation for every attachment and refuses stale or still-pending context. Historical captures and crops remain visible as stale evidence.

## Verification

Local non-browser checks:

```bash
npm run check
npm run build
```

Unit coverage includes camera-scale crop conversion/clipping, retained-instance versus replacement identity, navigation/document staleness, bounded malicious bridge records, and canonical source/line validation. Existing Electron suites continue to exercise scaled SVG/button picking, zero click-through, multi-preview accumulation, source fingerprints, screenshot capture, HMR staleness, SPA navigation staleness, and Vite/Next integrations.
