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

## Releasing

See the "Releasing" section of the [root README](./README.md).
