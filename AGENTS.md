# Agent working agreements

## Commit cadence

- **Commit often.** Prefer small, coherent commits over one large one. Commit as
  soon as a unit of work stands on its own (a module, a config, a test file).
- **After every commit, double check the code.** Re-read the diff that was just
  committed, re-run the relevant checks (`pnpm typecheck`, `pnpm test`,
  `pnpm build`), and fix what the check surfaces in a follow-up commit rather
  than letting it accumulate.

## Repository

- Workspace: pnpm, `packages/*`.
- Build: `tsdown`. Tests: `vitest`. Types: `tsc -b`.
- `PLAN.md` is git-ignored and tracks in-progress work.
