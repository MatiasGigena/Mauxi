# Workspace guide

## Open and close a project

Mauxi opens one local project at a time. **Open Project** statically inspects manifests, lockfiles, workspace declarations, scripts, and Git status without evaluating project configuration. The folder picker starts at the last successfully inspected project folder, remembered across restarts. It falls back to your home folder when no location is saved or the saved folder is no longer accessible. Cancelling leaves the saved location unchanged.

1. Use **Configure** to inspect the canonical app root, framework, package manager, exact command and preview URL, and choose the intended app/script when discovery finds several candidates. **Application and script** is an inline command-only selector; the menu shows each full command without project-name prefixes. Folder paths remain available in option tooltips and accessible labels to distinguish identical commands. Arrow keys, Home/End and typing navigate; Enter selects, Escape dismisses the menu first, and Tab moves on. Technical details fade out in 90ms while the menu is open and fade/rise back in 160ms when it closes, without a layout shift. Keyboard and reduced-motion changes are instant. A single available command remains visible but cannot be changed.
2. Use **Review** under **Temporary integration** to inspect the proposed file changes. Opening a file focuses its diff; additions are green, removals red. Escape returns to the file list, then to the setup overview.
3. Install missing project dependencies yourself; Mauxi does not install them during setup.
4. Choose **Confirm & start**. Direct Vite/Next scripts receive a session-only port argument; if their usual port is occupied, Mauxi chooses a free port and leaves the existing server alone. Mauxi waits for Vite to serve the instrumented HTML after configuration reload.
5. Wait for both preview bridges, not just HTTP readiness.
6. **Close project** or quit to stop the process group Mauxi started and remove its unchanged temporary integration.

Configure and Review keep their action icons visible and reveal their labels on row hover or keyboard focus, without a filled background. Labels stay visible while expanded and on touch devices; keyboard reveals are instant, and reduced motion removes the small horizontal movement.

**Not this project?** changes to **Choose another** on hover (or keyboard focus) and reopens Electron’s native folder dialog. Cancelling preserves the current project and selected script. There is no browser upload or prototype picker. Configure, Review and file disclosures expand inline with reversible motion; keyboard activation is immediate and reduced motion uses a short fade. Each new setup view enters with a subtle 280ms sequence (logo first, then heading, options, actions; 200ms fade-and-rise with 20ms staggering), without replaying on plan changes or cancelled selection. Reduced motion uses a simultaneous 120ms fade.

Saved setup only preselects a later confirmation; it does not automatically rerun commands. Temporary integration is journaled before mutation. Cleanup preserves changed files, unrelated dirty/untracked work, and the Git index. Unfinished setup/cleanup is retried on next launch, and conflicting artifacts are surfaced rather than overwritten. Unfinished journals are never automatically evicted; 64 unfinished valid journals block new setup.

Previews opened through the app start at `/`. Previously saved routes or `mauxi.startPath` metadata do not change the starting route selected by the setup screen.

For an owned Next.js session, a temporary config wrapper adds the local development origin and redirects build output and TypeScript configuration into `.mauxi/runtime/`. Vite's dependency cache is isolated there too. The original config expression stays editable and its production behavior is unchanged. On close, Mauxi stops the owned process group before removing the wrapper, hooks and private cache; existing `.next` and dependency caches are preserved.

Next.js attachment is disabled because an external server's cache cannot be isolated reliably after it has started. A detected Next development server in the same project must be closed before import; Mauxi will not stop it or delete its cache. Unsupported compound scripts cannot automatically change ports.

Next-generated `next-env.d.ts` changes are reconciled against the pre-session content and the installed Next generator's expected output. Independent user edits survive. Overlapping edits, moved files and changed ownership remain explicit recovery conflicts; Mauxi never resets the repository. A durable launcher receipt records the Linux process identity before starting the dev command, allowing restart recovery to stop that exact group before cleaning its private cache. Unknown surviving descendants are reported, not killed by port. The `.mauxi/runtime/` directory is reserved for disposable session output; application source and user assets must stay outside it.

### Supported setup

- React + Vite with one unambiguous static `plugins` array in `vite.config.ts`, `.mts`, `.js`, or `.mjs`.
- Next.js 15.3+ using `instrumentation-client`, including Webpack and Turbopack. Mauxi adds a marked development-only import or an owned temporary client file and a reversible wrapper around a single default export or `module.exports` assignment in `next.config`. Ambiguous exports are rejected.
- npm, pnpm, and Yarn scripts with dependencies already installed. The packaged app looks in `PATH` and common Linux user installation locations without executing shell profiles.
- Loopback HTTP origins. Unsupported or ambiguous setups are rejected before mutation; occupied ports are not taken over.

The preview bridge is development-only. Project pages receive no Node, Electron preload, filesystem, or provider-credential API. Only embedding response headers are adapted for the two authorized previews, as described below; other CSP restrictions, third-party cookies and external OAuth flows can still prevent integration. Desktop and mobile share browser storage within a workspace; separate workspaces have separate persistent partitions.

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

For the two previews of an approved local project, Mauxi adapts response headers that prevent embedding: it replaces CSP `frame-ancestors` with the Mauxi shell origin and removes `X-Frame-Options`. Other CSP directives remain enforced. This applies only inside the active workspace window; nested frames, other windows, subresources and other origins keep their original headers. Closing the workspace ends the exception. Project configuration and production responses are unchanged. A project's other restrictions, such as blocking the bridge script, can still prevent integration.

## Select elements

**Select** enables hit testing without activating the page beneath it. **Up/Down** refines the DOM child/parent path; **[ / ]** cycles overlapping targets; **Enter** attaches the target; **Escape** exits. DOM ancestry and React ownership are shown separately.

Desktop/mobile picks accumulate as distinct removable attachments, with bounded/redacted DOM, styles, route, viewport, source hints, and clipped screenshot context. Source hints are verified against canonical project paths, an unambiguous parsed JSX match inside the selected test-ID anchor, and a file fingerprint; ambiguous or dependency-only locations are not presented as verified application source.

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
