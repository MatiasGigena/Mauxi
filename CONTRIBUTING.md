# Contributing to Mauxi

Thanks for helping. Mauxi is a small Linux-only project; please open an issue to discuss larger changes before writing them.

## Set up

Use Linux with Node.js 22, npm and a graphical desktop:

```bash
npm ci
npm run dev
```

[Development](docs/development.md) lists the system requirements, every test suite and the ports they use.

## Before you open a pull request

- Run `npm run check` (types, lint and unit tests). It makes no paid model calls.
- Run the end-to-end suites your change touches, one at a time: they share fixture files and ports. Prefer end-to-end tests to unit tests for new behavior.
- Do not commit generated output: screenshots, traces, logs, `test-results/`, `evidence/` or `release/`.
- Do not commit content you do not have the right to redistribute, such as screenshots of third-party sites, or private project code, credentials or session history.
- Keep the layering: `src/presentation` → `src/application` → `src/infrastructure`.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`fix(audit): …`, `docs(readme): …`).

## Bend

Selection freshness rules live in `bend/selection.bend`, the rules they must keep in `LAWS.bend`, and their proofs in `PROOF.bend`. After editing any `.bend` file, run `npm run bend:proof` (it must print `ALL PROOFS CHECK`) and `npm run bend:build`. Never hand-edit `src/application/generated/selection.mjs`. `LAWS.bend` is maintainer-owned: propose new or changed laws in an issue. [AGENTS.md](AGENTS.md) has the full rules and checker pitfalls.

## Third-party code

Vendored code keeps its license and an `UPSTREAM.md` provenance record next to it (see `tools/oxlint/anti-slop/`). Record the source commit and every local deviation when you update it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
