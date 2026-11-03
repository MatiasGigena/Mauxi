# Bend selection rules

Bend 2.0.39 (`curl -fsSL https://bend-lang.com/install.sh | sh`, installs to `~/.bend`).

## What lives in Bend

`selection-state.ts` decides which picked elements get on-canvas markers and which go stale after a route or document change. Those decisions live in `bend/selection.bend`, compiled with `bend -o *.mjs` into `src/application/generated/selection.mjs` and called through a small adapter in `selection-state.ts`. TypeScript keeps the full `SelectionCapture` records; Bend sees one `Sel{preview, generation, current, repick}` per selection and returns one flag per selection.

`LAWS.bend` states eight rules, all proven in `PROOF.bend`:

- each mask (markers, route change, document change) has exactly one entry per selection, so the adapter's index lookup is sound;
- never more than `n` markers (Mauxi passes 8);
- only live selections (current, no repick, same preview and document) get a marker;
- a route change stales exactly the selections on that preview, and no others;
- a document change never stales a selection on the other preview;
- a document change never stales a selection already on the new document.

Planted bugs (over-marking in `cap`, a document change ignoring the preview, a route change hitting the wrong preview) each make `npm run bend:proof` fail with the exact case that breaks.

## Interop facts

- `-o x.mjs` exports every non-IO def as `default["Module.name"]`; output is deterministic.
- Strings and `Nat` cross as JS strings and numbers, `Bool` as `true`/`false`, constructors as `{$: "Name", ...fields}`, lists as `{$: "Con", head, tail}` / `{$: "Nil"}` (the adapter converts arrays).
- Vite and esbuild bundle the `.mjs` unchanged; `.d.mts` gives it types.
- The JS target is single-threaded and uses JS recursion for non-tail calls: stack depth grows with list length. `String.eq` compares char by char.

## Why the rest should stay TypeScript

- `src/infrastructure` and `src/presentation` (~14k lines) are Electron, React, Playwright, axe-core, the filesystem and the agent SDK. Bend's JS target has no DOM, and only IO-free defs are importable from JS.
- Bend has no JSON, regex, URL parsing or F64. The IPC contracts validate untrusted JSON, `route-link.ts` relies on `URL` and regexes, and the canvas and geometry code needs double precision (Bend has only F32, and proves nothing about it).
- Everything must be annotated, recursion must be provably terminating, values are affine, and mutual recursion is banned. Even this small module needed restructuring (`live_mask` + `cap`) to satisfy the checker.

## Where else Bend fits

Use Bend for small, rule-heavy pure decisions where a proven law has real value, behind TypeScript adapters. Candidates: selection freshness (done), audit scoring and severity rules in `audit-report.ts`, and workspace lifecycle transitions in `workspace-manager.ts` once their I/O is separated out. A full migration is not feasible with Bend 2.0.x.

## Commands

- `npm run bend:proof` — prove `LAWS.bend`.
- `npm run bend:build` — regenerate `src/application/generated/selection.mjs`.
- `bend PROOF.bend --verdict` rechecks with the Lean-verified kernel; it needs Lean 4.34 and has not been run yet.
