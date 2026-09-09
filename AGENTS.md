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

## De-slop

Review for AI slop and remove it. Concretely:

- **Dead abstraction.** Wrappers that only forward to something else, indirection
  files that re-export one module, options nobody passes, type parameters that
  appear once, `_tag` discriminants never discriminated on.
- **Unused exports.** If nothing imports it and it is not deliberate public API,
  delete it. Do not export "just in case".
- **Comments that restate the code.** `// build the map` above a map build.
  Keep the ones that explain a non-obvious why -- a workaround, a subtle
  ordering, a rejected alternative.
- **Doc-comment padding.** A one-line summary beats three sentences of throat
  clearing. No `@param` that restates the parameter name.
- **Ceremonial defensiveness.** Guards for conditions the types already rule
  out, `?? undefined` on an optional call, try/catch that rethrows unchanged.
- **Copy-paste tests.** Near-identical cases that differ by one literal belong
  in a table, and repeated setup belongs in a helper.
- **Inflated prose.** In docs and commit messages, say the thing once. Cut
  "powerful", "seamless", "robust", "simply", and restated section headers.

Prefer deleting code to adding it. The smallest version that a reader
understands on one pass wins.

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
