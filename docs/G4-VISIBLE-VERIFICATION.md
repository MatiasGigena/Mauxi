# G4 — Visible-preview verification (#8)

Implemented locally for Linux. This is deterministic capability/safety evidence, **not** acceptance of real-model design quality (AC-19).

## User flow

1. Open the trusted project and wait for both previews.
2. Choose **Give agent control**. Both existing frames become pointer- and keyboard-inert before the host grants a new control generation. The canvas fits both without remounting them; chat remains reachable.
3. The agent can inspect/capture the current previews. Every interaction—including hover, typing, scrolling and navigation—requires a separate **Approve once** decision showing the exact operation and identity. Click/type/hover approvals also show the original live element's tag, text/label, role, test ID, input type and preview coordinates, resolved by the host rather than supplied by the model. These details are rechecked atomically with dispatch; changed targets expire the approval. Use development/test accounts: localhost can call production backends.
4. **Take back control** immediately invalidates the generation and cancels pending approvals/queued actions. Already-dispatched bounded work drains before the input shields leave. **Stop** additionally aborts pi and cancellable tools, not the unrelated project dev server.
5. **Checks** shows actual recorded observations and PNG captures grouped by desktop/mobile. An untouched preview is explicitly “Not checked this run.” A dispatched action is not described as a successful user journey. New agent runs reset the ledger/budget.

Route linking is deliberately **paused (unlinked)** on handoff and stays paused after return. Agent actions never replay into the peer. To inspect another route in both previews, approve navigation separately for each; each navigation invalidates the current generation and needs a new handoff. The human can explicitly re-enable ordinary route linking afterward. No HTTP rollback is promised.

## Boundaries and implementation

- `application/browser-control.ts`: one in-memory human/picker/agent owner, monotonic generation, abort controller and serialized queue shared by both previews. Exact document/workspace/control validation occurs before and after approval. Failed tools, model errors/settlement, Stop and disconnect return control.
- `infrastructure/electron/visible-browser.ts`: attaches Electron's in-process debugger to the **existing window**, never launches Chromium or opens a debugging server. Direct frame ownership is checked through the trusted shell's actual iframe DOM nodes—not page-reported preview names. Production `file://` out-of-process iframe targets are joined only when their parent is this shell and their owner node matches. Document identities are host-generated, invalidated on document/SPA navigation, detach or load.
- `infrastructure/preview/browser-script.ts`: fixed, bounded operations in an isolated world. No model-supplied evaluation, selectors, storage/cookie reads, arbitrary getters, filesystem access or nested-frame automation. Document-local handles retain original DOM nodes and identity fingerprints; identical replacements fail stale checks. HTML field values and editable content are redacted from inspection.
- Screenshots use the visible window compositor and the trusted shell's geometry, with pre/post geometry checks. Hidden, clipped, overlay-obscured and changing captures fail rather than substituting an offscreen page. Images are actual PNG tool content for image-capable models, and actual image previews for the user. Screenshots may contain visible project-private data; handoff is not permission to expose provider credentials, which never enter preview storage.
- Source reads return a host-verified bounded static JSX candidate for a unique literal test ID, or an explicit unverified result. They do **not** claim runtime React ownership. Existing picker attachments still supply React Grab provenance and verified file fingerprints; collapsed DOM ancestry and React ownership remain separately inspectable.
- Click/type/hover dispatch synthetic DOM events. Hover additionally applies Chromium's `:hover` state and clears it on release. Native trusted-event, OS pointer and complete user-gesture fidelity remain unverified. Password/file/hidden-field typing is unsupported. Ordinary project handlers may still have remote side effects, hence conservative exact approval for all interactions.
- Console/page-error observations are limited to the connected document, 40 entries of 1,200 characters. Remote console objects/getters are not expanded. No entries is not proof of an error-free page.
- The trusted IPC boundary accepts only the current shell's main frame. Preview bridge messages cannot grant control or approvals. Unknown capabilities, extra authority fields, foreign workspace/frame identities, stale handles/generations, unsupported origins/action/callback routes, popups and permission requests fail closed. A 4-second shell heartbeat also revokes control and stops an active agent after UI loss.
- Per run: 24 browser calls, 4 screenshots, 16 model turns, 5-minute deadline and at most one provider retry. PNGs are capped at 5 MiB and 1,600 pixels wide; DOM inspection visits at most 2,000 elements and returns 80 entries. Fixed synchronous page code has a 2-second Chromium execution deadline. These bound retry loops, not an exact monetary cost across providers.

## Verified evidence

Run:

```sh
npm run check
npm run test:browser-e2e
npm run test:e2e
npm run test:lifecycle-e2e
npx playwright test --config playwright.resources.config.ts
```

- `tests/unit/browser-control.test.ts`: cross-preview serialization, pending/queued/new action revocation, drain-before-handoff, exact approval denial, document changes during approval, stale DOM failures, budgets and forged capabilities/messages.
- `tests/unit/browser-agent.test.ts`: real pi SDK with a local fake provider. Actual image tool blocks reach that provider; success, model error, Stop and UI disconnect return control. An unrelated test server stays alive. No existing pi credentials or paid model requests are used.
- `tests/unit/dom-source.test.ts`: bounded static matching, ambiguity, cancellation and symlink escape rejection.
- `tests/browser-e2e/visible-browser.spec.ts`: human increments the existing visible desktop counter **before** tool attachment; inspection sees that same value while mobile remains unchanged. Captures do not create additional WebContents. Real approval UI, original-node replacement, stale/foreign/eval requests, forged page messages, take-back during approval, recorded screenshot UI, a safely intercepted local POST counter, no peer replay, and explicit human route relinking are exercised.
- `tests/browser-e2e/browser-operations.spec.ts`: Vite dev renderer **and Next.js Webpack with the built `file://` renderer/OOPIFs**. Hover/CSS release, typing, scroll, console/page errors, actual captures, denial, exact navigation, stale navigation generations, external/callback rejection, debugger disconnect, reachable chat and reduced-motion presentation.
- Existing workspace, lifecycle and resource Electron regressions remain covered. Old proof-only “Send demo” assertions now assert that a non-project/non-model composer cannot send; real sending is exercised by SDK tests instead of a fictitious completion.

The implementation validation transcript is in [`evidence/issue-8`](../evidence/issue-8/). Browser tests also generate local PNG evidence there using safe fixture data; testing images are intentionally not committed. `visible-desktop.png` records the pre-agent counter at 1; `recorded-checks.png` shows the retained real capture even after the visible counter advances to 2.

## Integration fixes discovered while testing

The host build now leaves the pinned pi SDK as a production dependency instead of flattening its CommonJS dependencies into ESM (which previously threw `Dynamic require of child_process`). Production `file://` bridge reconnects also accept Chromium's serialized opaque `null` sender origin, **only** for the expected file shell and with the existing parent-window/session/document checks intact. Neither fix disables sandboxing or web security.

## Still unverified

No live provider/design-quality run, human assessment of the six real design tasks in AC-19, real-device behavior, arbitrary internet automation, third-party frames, trusted native input fidelity, or replay/rollback of sent HTTP effects is claimed. The G4 acceptance work must still include that human/real-project design assessment; do not infer it from deterministic mocks or mark it complete on this evidence alone.
