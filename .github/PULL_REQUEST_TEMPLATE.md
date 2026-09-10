## What changed

<!-- One paragraph. What and why. -->

## Checks

- [ ] `pnpm format:check`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm demo`
- [ ] `pnpm pack:check` (if the change touches a package manifest or build)

## Review

- [ ] Logic checked against the real control flow, not the intended one
- [ ] New guards have a test that fails when the guard is removed
- [ ] No accidental `any`; errors land at the mistake
- [ ] Comments explain why, not what
