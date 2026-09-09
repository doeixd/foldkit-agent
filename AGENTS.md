# Agent working agreements

## Commit cadence

- **Commit often.** Prefer small, coherent commits over one large one. Commit as
  soon as a unit of work stands on its own (a module, a config, a test file).
- **After every commit, double check the code.** Re-read the diff that was just
  committed, re-run the relevant checks (`pnpm typecheck`, `pnpm test`,
  `pnpm build`), and fix what the check surfaces in a follow-up commit rather
  than letting it accumulate.

## Reviewing a commit

When re-reading a commit, check each of these deliberately:

- **Logic and correctness.** Does it do what the message claims? Trace the real
  control flow, not the intended one.
- **Edge cases.** Empty, missing, duplicate, already-aborted, out-of-order,
  called-twice, called-after-dispose.
- **Synergy with existing features.** Does it compose with what is already here,
  or does it bolt on a second way to do the same thing?
- **Types and TypeScript DX.** No accidental `any` (especially from
  `Parameters<>` on intersections or circular conditionals). Errors should land
  at the mistake and read clearly. Inference should work at the call site
  without annotation ceremony.
- **Comments.** Explain why, not what. Delete any comment that restates the code.
  Doc comments on public API, none on the obvious.
- **Tests.** See below -- they must be able to fail.
- **Security hardening.** Untrusted input crosses a validation boundary before
  anything else; capability and authorization checks cannot be skipped; failures
  do not leak internals.
- **Performance.** Work done once at definition time rather than per call;
  no accidental O(n) lookups or repeated derivation in a hot path.

Fix what the review finds in a follow-up commit rather than letting it sit.

## Tests

- **Verify every test can actually fail.** After writing tests, mutate the code
  under test (invert a condition, drop a guard, return a constant) and confirm
  the relevant test goes red, then revert. A test that passes against broken
  code is worse than no test.
- Assert on real behaviour, not on restatements of the implementation. No
  assertions that hold vacuously (`expect(x).toBeDefined()` on a value that is
  always defined), no tests that only exercise a mock, and never weaken an
  assertion to make a test pass.
- If a test cannot be made to fail, delete it or replace it with one that can.

## Repository

- Workspace: pnpm, `packages/*`.
- Build: `tsdown`. Tests: `vitest`. Types: `tsc -b`.
- `PLAN.md` is git-ignored and tracks in-progress work.
