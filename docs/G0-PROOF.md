# G0 proof — live previews and source-linked selection

**Decision: GO for the isolated DOM iframe approach on the tested Linux matrix.**

This is a deliberately narrow feasibility result for issue #1, not a general browser compatibility claim. Two cross-origin iframe artboards remain live while a CSS camera transform moves and scales them. A development-only bridge runs inside each preview and communicates through bounded, origin/session/generation-checked `postMessage` messages. The shell does not reach into a frame DOM and Electron `webSecurity` remains enabled.

## Tested matrix

Tested on Linux `7.0.0-31-generic` x86_64 with Node `22.23.1` / npm `10.9.8`:

| Surface | Pinned version / choice |
| --- | --- |
| Electron / Chromium | Electron `44.4.1`, Chromium `152.0.7977.78` |
| Shell | React `19.3.0`, Vite `7.3.6`, TypeScript `5.9.3` |
| Vite fixture | React `19.3.0`, Vite `7.3.6` |
| Next fixture | Next.js `16.3.5` App Router, React `19.3.0`, **Webpack** (`next dev --webpack` / `next build --webpack`) |
| Picker | `react-grab` primitives `0.2.0` |
| Browser checks | Playwright `1.63.0` driving the visible Electron window |

No claim is made for Next.js Pages Router, Turbopack, alternative Vite plugins, other React versions, or other operating systems.

## What the proof demonstrates

- The shell shows desktop `1440 × 900` and mobile `390 × 844` live previews for either fixture. Camera zoom is a transform around fixed iframe dimensions; checks at 70% confirm both fixtures still report the original CSS layout viewports.
- Artboard headers track pointer dragging 1:1. Both previews keep accepting ordinary input when selection is off.
- At 70% camera zoom, selecting the nested SVG/button target yields React Grab provenance to the expected `ProofCard.tsx` JSX line. A fixture-scoped host resolver turns React Grab's sometimes basename-only hint into one unique project-relative path and SHA-256 fingerprint. The picker capture phase suppresses the underlying React click; counters remain zero.
- Captures use the transformed iframe's exact shell rectangle. At 70%, the desktop capture is `1008 × 630`, contains only the preview viewport, and excludes the artboard header, peer artboard, and shell chrome. See [`captures/vite-desktop-70.png`](captures/vite-desktop-70.png) and [`captures/next-desktop-70.png`](captures/next-desktop-70.png).
- Vite and Next Webpack hot updates both change the visible target without remounting the shell. Revalidation compares the original selector/test ID/text/source identity and marks the changed target **stale** instead of silently accepting it.
- The Vite fixture uses a browser cookie and the Next fixture uses an HTTP-only cookie set by an App Router route handler, crossing a server/client component boundary. Authentication works in frames. The two same-workspace previews share cookie storage, as expected.
- Temporary integration records a durable journal before mutation, adds a marked development-only config region plus an owned `.mauxi/bridge.js`, and removes only those additions. Unit checks recover through a fresh journal-store instance and preserve an unrelated config edit. Changed owned artifacts are preserved and reported as conflicts.
- With the integration hooks deliberately left in each config, both production builds complete and contain none of the bridge signatures (`mauxi-preview-v1`, overlay markers, React Grab bridge diagnostics, or plugin name). Normal cleanup restores both configs and removes the generated artifacts.
- Project pages receive no Node integration, filesystem API, Electron preload API, or credentials. The Electron host uses `contextIsolation`, renderer sandboxing, `webSecurity`, top-frame IPC sender checks, denied popups/permissions, fixed preview origins, and bounded bridge messages.

## Reproduce

```bash
npm install
npm run check
npm run test:e2e
npm run instrument:apply
npm run verify:production
npm run instrument:clean
```

`npm run test:e2e` owns cleanup through a shell trap, starts only the pinned local fixtures on `127.0.0.1:45173` and `127.0.0.1:45000`, starts the shell on `127.0.0.1:44173`, drives the visible Electron previews, and refreshes the two canonical captures. Recovery journals default to `~/.config/Mauxi/recovery`; the automated proof redirects them to the ignored `.mauxi-proof-state/` folder.

To inspect manually:

```bash
MAUXI_STATE_DIR="$PWD/.mauxi-proof-state" npm run instrument:apply
npm run fixtures:dev   # terminal 1
npm run dev            # terminal 2
# then: MAUXI_STATE_DIR="$PWD/.mauxi-proof-state" npm run instrument:clean
```

## Honest limitations and observed failures

- Ports `5173` and `3000` were already occupied by unrelated local applications. The proof did **not** kill or attach to them; fixture ports were moved to the explicit high ports above. Full project launch/ownership UX belongs to G1.
- React Grab `0.2.0` can return only `ProofCard.tsx` for the Vite JSX frame. This proof resolves it only when exactly one matching source file exists under the selected fixture, then fingerprints that file. Duplicate basenames remain ambiguous and must be surfaced rather than guessed in the product implementation.
- The frame/cookie result covers loopback pages whose framing policy permits embedding. `X-Frame-Options`, restrictive CSP `frame-ancestors`, different-site third-party-cookie rules, OAuth callback flows, and production authentication origins remain real constraints. No headers were weakened in these fixtures.
- The two previews intentionally share an Electron session in this proof, so they are not independent accounts. Workspace-partitioned storage across different projects is not implemented yet.
- Captures are correct presentation-space crops. A native-CSS-pixel export independent of camera zoom would need a separate capture path; this proof does not claim one.
- The host source resolver is fixture-specific and read-only. A full adapter must validate canonical workspace paths, ambiguity, source-map generations, file changes, and more provenance cases without trusting page hints.
- Open/closed shadow roots, canvas/WebGL, cross-origin child frames, pseudo-elements, portal hierarchy refinement, overlapping targets, route mirroring, and the complete fault-injection matrix were not claimed by this issue slice.
- Recovery is demonstrated through durable transaction records and next-process cleanup tests, not a recovery UI. An unconditional power loss during the filesystem's own final write cannot be simulated here; atomic journal replacement is used.

Within those boundaries, the hard interaction is viable and the successful bridge, canvas, selection records, capture path, and cleanup journal are reusable for the next implementation slices.
