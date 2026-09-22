# Workspace guide

## Open and close a project

Mauxi opens one local project at a time. **Open project…** statically inspects manifests, lockfiles, workspace declarations, scripts, and Git status without evaluating project configuration.

1. Choose the intended app and development script if discovery finds several candidates.
2. Review the canonical app root, framework, package manager, exact command, preview origin, and temporary integration diff.
3. Install missing project dependencies yourself; Mauxi does not install them during setup.
4. Choose **Confirm & start**, or **Attach to existing** for a user-owned server on the shown port. If attachment changes a configuration the server has already loaded, restart that server yourself when prompted.
5. Wait for both preview bridges, not just HTTP readiness.
6. **Close project** or quit to stop the process group Mauxi started and remove its unchanged temporary integration. Attached servers are left running.

Saved setup only preselects a later confirmation; it does not automatically rerun commands. Temporary integration is journaled before mutation. Cleanup preserves changed files, unrelated dirty/untracked work, and the Git index. Unfinished setup/cleanup is retried on next launch, and conflicting artifacts are surfaced rather than overwritten. Unfinished journals are never automatically evicted; 64 unfinished valid journals block new setup.

### Supported setup

- React + Vite with one unambiguous static `plugins` array in `vite.config.ts`, `.mts`, `.js`, or `.mjs`.
- Next.js 15.3+ using `instrumentation-client`, including Webpack and Turbopack. Mauxi adds a marked development-only import or an owned temporary client file, without rewriting `next.config`.
- npm, pnpm, and Yarn scripts with dependencies already installed. The packaged app looks in `PATH` and common Linux user installation locations without executing shell profiles.
- Loopback HTTP origins. Unsupported or ambiguous setups are rejected before mutation; occupied ports are not taken over.

The preview bridge is development-only. Project pages receive no Node, Electron preload, filesystem, or provider-credential API. Frame policies, CSP, third-party cookies, and external OAuth flows can still prevent embedding; Mauxi does not weaken headers to bypass them. Desktop and mobile share browser storage within a workspace; separate workspaces have separate persistent partitions.

## Canvas and previews

- **Move:** drag an artboard header, or use its keyboard move handle with arrows (Shift for larger steps).
- **Pan:** drag empty canvas, or enable **Hand** and drag over a preview. Wheel on the canvas pans; Ctrl+wheel zooms around the pointer. Ordinary page scrolling remains independent.
- **Zoom:** 25–200%. **Fit both** fits current artboard bounds; **Reset** restores a 100% camera without discarding positions or viewport settings.
- **Viewports:** initially desktop 1440×900 and mobile 390×844 CSS pixels. **Actions → Viewport** changes iframe dimensions, within 240–3840 wide and 240–2160 high. Camera zoom does not change responsive breakpoints.
- **Focus:** fits one board and hides, rather than remounts, the other. Unfocus restores the previous camera and positions. Page state survives.
- **Chat:** stays anchored to the window. Drag its separator or use Up/Down/Home/End on the focused separator to resize it.
- **Actions:** reload, viewport, screenshot, route copy, and diagnostics. Screenshot capture requires Electron and the entire preview to be visible; it captures presentation-space pixels, not a zoom-independent native-size export.

Layout, viewport sizes, focus restore state, chat height, and route-link preference are saved with the workspace. Live element handles and preview generations are not persisted.

## Routes

Linked routes mirror a supported same-origin **URL navigation**, not clicks, submissions, scrolling, or `history.state`. Authentication/API/action/callback paths and sensitive query/hash keys are conservatively excluded. Form-originated navigation is excluded too. Unlinking stops synchronization; **Actions → Copy route** remains available for supported routes.

A mirrored navigation can reset the peer's page state and issue a GET request. Mauxi cannot infer arbitrary custom side-effectful GET endpoints: unlink for those flows. External navigation is restricted to approved project origins, and a page without a responding bridge cannot be selected.

## Select elements

**Select** enables hit testing without activating the page beneath it. **Up/Down** refines the DOM child/parent path; **[ / ]** cycles overlapping targets; **Enter** attaches the target; **Escape** exits. DOM ancestry and React ownership are shown separately.

Desktop/mobile picks accumulate as distinct removable attachments, with bounded/redacted DOM, styles, route, viewport, source hints, and clipped screenshot context. Source hints are verified against canonical project paths, an unambiguous JSX match, and a file fingerprint; ambiguous or dependency-only locations are not presented as verified application source.

Selections retain rendered-instance identity through safe reorders, but remounts, navigation, document replacement, and source changes can make them stale. Every send revalidates the attachments; failed preflight preserves the draft. Historical crops remain inspectable but never authorize a replacement element. Text-only models reject captured image context rather than silently ignoring it.

Canvas/WebGL pixels and cross-origin child-frame contents are unsupported; pseudo-elements resolve to their owning DOM element. Form values are redacted from textual context, but **screenshots can still contain private information**.

## Give the agent preview control

1. Choose **Give agent control**. Mauxi fits both existing previews without remounting them and blocks human pointer/keyboard input into the frames; chat remains reachable.
2. Inspection and capture operate on those same visible frames. Every interaction, including hover, typing, scroll, and navigation, needs an exact **Approve once** decision. Target identity, label, and geometry are checked again at dispatch.
3. **Take back control** cancels pending approvals and queued actions. Already-dispatched bounded work drains before input is returned. **Stop** also aborts the agent, not the project's unrelated dev server.
4. **Checks** shows actual observations and PNG captures separately for desktop/mobile. A dispatched action is not proof of a successful user journey; untouched previews say so.

Route linking is paused on handoff and stays paused after return. Approve each preview's navigation separately; navigation invalidates control and requires a new handoff. You can explicitly re-enable ordinary route linking afterward. Sent HTTP effects cannot be rolled back.

### Verification limits

- Use development/test accounts: localhost projects can call production backends.
- Browser operations use bounded host-authored capabilities, not arbitrary agent JavaScript, selectors, cookie/storage reads, or nested-frame automation.
- Captures reject hidden, clipped, overlay-obscured, or changing geometry instead of substituting an offscreen browser.
- Click/type/hover use synthetic events; native trusted-event and OS input fidelity are not guaranteed. Password, file, and hidden-field typing are unsupported.
- Console observations include at most 40 entries of 1,200 characters from the connected document. An empty log does not prove an error-free page.
- Each run permits 24 browser calls, 4 screenshots, 16 model turns, a five-minute deadline, and at most one provider retry. Images are capped at 5 MiB/1,600 pixels wide; DOM inspection visits at most 2,000 elements and returns 80 entries. These are execution bounds, not an exact spending cap.
- Stale documents, replaced nodes, foreign identities, denied actions, errors, Stop, and disconnect revoke control. Loss of the shell heartbeat also stops an active agent.

Desktop emulation does not establish real-device behavior, general internet automation, third-party frame support, or real-model design quality. Review the result yourself, including accessibility and any remote effects.

For live edits and disk recovery, see [Changes, approvals, and recovery](changes-and-recovery.md).
