# Contributing

## Layout

- `packages/*` — the published packages plus the in-tree packages that are still
  `private` (`foldkit-surface`, `foldkit-remote*`, `foldkit-mixins*`).
  `foldkit-agent` is the contract; the adapters depend on it.
- `examples/*` — worked examples that import the packages through their
  published entry points.

## Before a commit

Run the checks CI runs. `pnpm check` runs all five in sequence:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm demo
pnpm pack:check
```

Format with `pnpm format`, never bare `prettier`: the repository config matches
the style already in the tree, and without it prettier rewrites files to its own
defaults.

## Tests

Every test must be able to fail. Mutate the code under test (invert a guard,
drop a branch, return a constant), confirm the relevant test goes red, then
revert. A test that passes against broken code is worse than no test. Assert on
behaviour, not on restatements of the implementation; repeated setup belongs in
a helper.

## TypeScript

Examples emit declarations (`emitDeclarationOnly`), so an exported value whose
inferred type expands a Foldkit-private alias fails with `TS2742`. Annotate the
export with a public type; `examples/sync/src/sync.ts` does exactly that with
`SyncContract<Message, Shared>` and explains why in a comment.

Typechecking is split into build and test projects. Each package has a
`tsconfig.build.json` (src only) that its consumers reference, so a leaf's
`tsc -b` never compiles a referenced package's `test/**`; the package's main
`tsconfig.json` keeps `test/**`, which is what the root `pnpm typecheck` uses.

`pnpm typecheck` is incremental; `pnpm typecheck:force` (what CI runs) rebuilds
every project, which is how to rule out a stale `.tsbuild` masking a change.

## Releasing

See the "Releasing" section of the [root README](./README.md).
