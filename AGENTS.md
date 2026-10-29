# Agent instructions

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.

## Bend

- Selection freshness rules live in `bend/selection.bend`; `LAWS.bend` states the rules they must keep, `PROOF.bend` proves them (`law x` is proven by `def Laws.x`).
- Install with `curl -fsSL https://bend-lang.com/install.sh | sh`; `bend` lands in `~/.bend/bin`. Run `bend guide` before writing Bend, and `bend base <Name>` to look up the Base library (e.g. `bend base String`).
- After editing any `.bend` file, run `npm run bend:proof` (must print ALL PROOFS CHECK) and `npm run bend:build` to regenerate `src/application/generated/selection.mjs`. Never hand-edit the generated file.
- `LAWS.bend` is human-owned: never edit, weaken or delete a law to make a proof pass. Propose new laws to the user for any rule that must not break.
- Only pure (non-IO) defs are callable from TypeScript. Lists cross as `{$: "Con", head, tail}` / `{$: "Nil"}`, `Bool` as `true`/`false`, strings and `Nat` as JS strings and numbers.
- Checker pitfalls: a def may only call defs written above it (no mutual recursion), `match` only takes parameters or pattern variables, never a computed value (pass it to a helper), and values are affine, so mark a `Data` parameter `+` to use it twice. In a proof, `?name` prints the current goal.
