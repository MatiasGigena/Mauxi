# G2 — Minimal canvas workspace

Implements [issue #3](https://github.com/MatiasGigena/Mauxi/issues/3) on the existing Linux/Electron project lifecycle. No canvas framework, extra service, or permanent settings panel was added.

## Controls and boundaries

- **Page mode:** pointer input, text entry, page scrolling and nested scrolling stay inside the selected preview. No shell-wide single-key shortcuts intercept typing.
- **Move:** drag either header; its grab point follows the pointer in screen pixels, including at 25% and 200%. Tab to the labelled move handle and use arrows (Shift for larger steps). Pointer cancellation/lost capture releases the input shields.
- **Pan:** drag empty canvas, or turn on **Hand** and drag over a preview. Wheel over canvas/Hand pans; Ctrl+wheel zooms around the pointer. Wheel inside a page or basic selection mode scrolls that page, not its peer.
- **Camera:** Fit both calculates bounds from current artboard positions, actual canvas space and unscaled headers. Reset restores a 100% camera at a small inset, without discarding viewport settings or artboard positions. The zoom slider is keyboard accessible. Zoom is bounded to 25–200%; exceptionally distant artboards may not both fit at the minimum zoom.
- **Viewports:** start at desktop 1440×900 and mobile 390×844 CSS pixels. Actions → Viewport changes the real iframe dimensions (240–3840 wide, 240–2160 high). Camera zoom never changes them.
- **Focus:** fits one board into the space above chat and hides, rather than unmounts, its peer. Unfocus restores the saved camera and positions. Switching focus first restores the original layout. Explicit viewport edits remain in effect. There is no transition to wait for or interrupt.
- **Header:** three primary actions: Select, Focus/Unfocus, Actions. Escape inside a selecting page exits selection. Picks suppress pointer activation and Enter/Space submission. The source-linked hierarchy and attachment behavior added by issue #4 is documented in [G2-SELECTIONS.md](G2-SELECTIONS.md).
- **Chat:** window-anchored, not camera-scaled. Drag its separator or use Up/Down/Home/End while it has keyboard focus. “Send demo” is explicitly local/fake and never edits files or calls a model.
- **Secondary tools:** reload, viewport dimensions, screenshot, route copy and diagnostics live in the Actions dialog. Native modal keyboard containment, Escape and explicit focus restoration are supported. External opening and the selection hierarchy are disabled rather than simulated. Capture is enabled only in Electron with the entire viewport visible, and removes the dialog/picker overlay before capturing.

SPA route changes mark that preview’s selection attachments stale and require a fresh pick, including back/forward, query and hash changes. Same-URL history-state updates and navigation in the other preview do not invalidate them. Late source-resolution/revalidation results cannot revive an attachment from the previous route.

Layout (camera, positions, sizes, focus restore state, chat height, linking preference) is validated and atomically saved through the existing `WorkspaceStore` record, preserving the launch plan. Writes are coalesced during manipulation; Close project flushes the latest layout. Preview generations and live handles are not persisted. Proof mode does not persist layouts.

## Linked routes: deliberately bounded

The bridge observes `pushState`, `replaceState`, `popstate`, hash changes and same-origin document loads. A peer receives a **URL navigation**, not a click, a form submission, scroll position, or serialized `history.state`. Next.js `Link` navigation is covered by the Linux test.

A frame-local bootstrap carries the session identity and navigation acknowledgement across same-origin document loads. The shell validates origin, source window, session, generation, schema and message size. Echoes and acknowledged redirects do not feed back. Unlink prevents automatic synchronization; Actions → Copy route works independently for a supported route.

Authentication/API/action/callback paths and sensitive query/hash keys are conservatively excluded. Form-originated navigation is excluded even when its destination looks ordinary, including native `form.submit()` (which skips the submit event), `requestSubmit()` and SPA form handlers. The marker is consumed by the resulting route; later independent router navigation resumes linking. Repeated same-URL history updates keep the form destination excluded. External links are visibly blocked; Electron also restricts subframe navigation/redirect requests to approved project origins. A document without a responding bridge disables selection and can be reloaded from Actions.

**Limits:** this is not an application router adapter and cannot infer arbitrary custom side-effectful GET endpoints. Unlink for those flows. A mirrored route may perform a normal GET/document load and reset the *peer's* page state; focus, camera changes and dragging never do. Opening external URLs needs a future checked external-open flow. Browser-only proof mode is not a substitute for Electron's navigation boundary.

## Linux walkthrough (executed)

1. Open the Vite fixture. The resting view is [two live previews, compact controls and chat](../evidence/g2/workspace.png). Drag a header at 25%, 50%, 100% and 200%; its grab point tracks 1:1. The mobile media query remains mobile at every camera scale.
2. Scroll to **Navigation and input**, enter a persistent note, focus Desktop, type/send a demo chat message and unfocus. The page's document marker, input value and prior artboard rectangle survive; chat stays usable.
3. Scroll Desktop with the wheel: Mobile does not scroll. Turn on Hand and drag/wheel above the page: the camera moves without a page action. Select a target: its counter remains zero. Enter does not submit a selected page's form; Escape exits selection.
4. Use **Client route**: Mobile reaches it once and receives no history-state object. Unlink, follow **Document route**, then explicitly copy it. Submit the fixture form: one POST and one local submission occur, neither in Mobile. The callback route is not mirrored, and its copy action is disabled.
5. Tab through header controls, open [Actions/diagnostics](../evidence/g2/actions.png), edit Mobile's width, and dismiss with Escape. Focus returns to the opener. Resize chat using its keyboard separator. Repeat focus/unfocus immediately, with [125% shell text, reduced motion and increased contrast](../evidence/g2/large-text-reduced-motion.png): controls remain readable and press feedback starts on pointer-down.
6. In the project lifecycle test, change Mobile's position/width, chat height, linking and focus; close and reopen the project. All persisted layout values and the launch plan return. Owned-server shutdown and conflict-safe integration cleanup still pass.

`/apple-design` choices: Linux system typography, rem-sized shell controls, opaque readable materials, labelled native controls, clear disabled states, immediate feedback and direct manipulation. No decorative motion, springs, blur dependency, or macOS imitation. The reduced-motion rule uses `transition: none`, not a tiny duration that accidentally introduces transitions on otherwise-static controls.

## Verification

Executed on Linux with Electron 44.4.1 and the repository's pinned Vite/Next.js fixtures:

| Command | Result |
| --- | --- |
| `npm run check` | TypeScript + 43 unit tests pass |
| `npm run build` | Renderer, host, preload and bridge build |
| `npm run test:e2e` | 13 Linux Electron tests pass, including native/SPA forms, linking recovery, SPA selection invalidation, Next Link and original picking/HMR/capture coverage |
| `npm run test:lifecycle-e2e` | Close/reopen, layout persistence and cleanup pass |
| `npm run test:turbopack-e2e` | Turbopack bridge regression passes |
| `npm run verify:production` | Both fixtures build; production output has no Mauxi bridge signatures |

Geometry, route policy/loop suppression, message schemas and workspace persistence: `tests/unit/canvas-routing.test.ts`. UI/route/accessibility coverage and reproducible screenshots: `tests/e2e/workspace.spec.ts`. Actual page input, focus, actions and route navigation were also exercised through browser tools; the supported route produced one peer document GET.
