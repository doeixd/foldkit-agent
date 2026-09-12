# Project improvements

Status: suggestions from one working session that reviewed and fixed
`foldkit-remote`, `foldkit-durable`, and `foldkit-sync`, built
`examples/kitchen-sink`, and revised the docs. Each item names the concrete
friction that prompted it, so it can be judged rather than taken on faith.

## If you do three things

1. **Fix the runtime seam.** The application-dispatch gap documented in
   `docs/sync-runtime-binding.md` is the one blocker that keeps Sync, Agent, and
   Surface from being transparent; everything else is polish next to it.
2. **Stop sharing one worktree between agents.** Two sessions committing to the
   same tree caused `git add -A` to sweep edits, and stale `.tsbuild` caches that
   passed alone but failed when rebuilt inside another project's graph.
3. **Split build tsconfig from test tsconfig.** A leaf project that references
   `packages/*` should not compile their `test/**`; see the first item under
   tooling.

## Tooling and process

- **`tsc -b` compiles referenced projects' tests.** While building
  `examples/kitchen-sink`, `tsc -b` rebuilt `packages/mixins` and
  `packages/remote-drizzle` including their `test/**`, surfacing another
  session's in-flight `@ts-expect-error` breakage in an unrelated leaf. Give each
  package a `tsconfig.build.json` (excludes `test`) and reference that; keep the
  test files in a separate project.
- **Incremental builds hide real breakage.** `pnpm --filter
  foldkit-remote-drizzle typecheck` passed on a stale `.tsbuild` while a forced
  build of the same package through another project failed. Run `tsc -b --force`
  (or `--clean` then build) in CI, not only incrementally.
- **One module-resolution story.** Examples resolve `foldkit-*` through `paths`
  to source; `foldkit-remote-drizzle` had to resolve from its built `dist`
  because source compilation broke it. The base config's module resolution
  ignores `exports`, so `dist` resolution is inconsistent. Pick
  `bundler`/`nodenext` and a single strategy, and document it.
- **A `pnpm check` script** that runs `format:check`, `typecheck`, `test`, `demo`,
  and `pack:check` in one command, so "run the four checks" is one word. (`ci`
  cannot be the script name: `pnpm ci` is a pnpm builtin and never runs it.)
- **`node:sqlite` under Vite** cost time twice. A Vite `ssr.external` / `test.server.deps.external`
  entry does not prevent the rewrite; a shared `createRequire` helper (the
  workaround recorded in `AGENTS.md`) is the fix, and it should live in one place
  rather than be copied into every sqlite-using package.

## Cross-package API consistency

- **Encoded typing should be universal.** `foldkit-durable` now has
  `Codec<Value, Encoded>` and `foldkit-remote` preserves `Encoded` through
  `ModelRef`/`Selection`, but `foldkit-sync`'s `journalContract` is still
  `unknown`-typed. Consider one shared `Codec` (or Effect `Schema.Codec`) rather
  than three idioms for the same wire-side concept.
- **Brands collide by name, not by meaning.** `foldkit-durable`'s `Sequence` and
  `foldkit-sync`'s `Sequence` are both "a document position" but different
  brands, so every cross-package seam needs `sequence(Number(...))` conversions
  (visible in `examples/kitchen-sink` and `examples/sync`). Share the brands, or
  namespace them so the conversion is obviously intentional.
- **Config vocabulary should match across siblings.** Resolved by #60:
  `forApplication(App).make(config)` across Agent and Sync, `Surface.make` for a
  feature Surface, `Projection`/`MessageSet` as the shared primitives.
- **Owner tokens should be checked everywhere.** Resolved: `Sync` and
  `Agent.exposeSubset` refuse a foreign subset, and `Module.validate` reports a
  foreign contract; each has a test.

## Architecture

- **The runtime seam is the real gap.** Foldkit `makeApplication` accepts no async
  admission hook and exposes no Model/dispatch handle, so Sync and Agent bridge
  by hand. The proposed `admission` service in `docs/sync-runtime-binding.md` is
  the highest-leverage upstream change; a small `foldkit-host` package owning the
  loop would be the fallback.
- **Sync's replay drops Commands.** `forApplication` derives replay from
  `update(...).model`, so a durable Message whose `update` produces Commands
  silently loses its effects during replay and optimistic projection. Either
  make durable Messages express their effects as data, or make the constraint
  impossible to miss at the definition site.
- **Durable recovery needs a worker.** `unfinished()`, `clearEffect`, and
  `runEffect({ retryFailed })` are good primitives, but the README's recovery
  policy still leaves every application to write the same scan/reconcile loop. A
  `makeRecoveryWorker` over those primitives would remove the most error-prone
  code in an app.
- **Remote's live adapter is unspecified.** The wire `LiveChange` and the client
  `LiveEvent` are two shapes with no reference adapter between them. Ship one
  (over `RemoteRpc`) plus a fake built from the wire spec, so each application
  does not re-invent the mapping.
- **One owner per datum deserves teeth.** The rule is documented; add a
  `Surface`-level notion of owner kind (local / remote / replicated) or a lint so
  a datum cannot quietly live in two caches.
- **Re-evaluate `foldkit-remote-drizzle`.** It is the largest and most fragile
  adapter, with a provisional bar in its own README. After the `EntityBinding`
  migration settles, decide whether it earns a package or is a recipe.

## Docs

- **Index `docs/` and retire superseded guides.** `docs/sync-dx.md` is
  superseded by `docs/design/REVISION_PLAN.md` but still sits among the guides.
- **Separate guide from API.** The guides and the package READMEs restate each
  other; a guide should link the READMEs and own the mental model only.
- **Move design notes out of package directories.** Done: `docs/design/` holds
  the agent, mixins, remote-drizzle, and surface design notes, so package
  directories are code + README.
- **A publish matrix.** With `foldkit-agent-native` now published and Surface,
  Remote, and Mixins still private, a single table of version, status, and
  release order would save guessing.

## Testing

- **Enforce "every test can fail".** The rule is in `AGENTS.md` but nothing
  checks it. A mutation pass over the pure cores (store, planner, connection,
  the Remote reducer) would find the redundant guards the rule warns about.
- **Make the examples the acceptance suite.** `examples/*/test` transcripts are
  the strongest end-to-end signal in the repo; give them a named CI check so they
  cannot rot.
- **Formalize cross-package type seams.** I added
  `examples/sync/test/journalContract.test-d.ts` to prove
  `Sync.journalContract()` satisfies `makeJournal`'s options. A handful of those
  ("this contract satisfies that consumer") would catch sibling drift at compile
  time.

## TypeScript DX

- **Declaration portability needs a pattern.** Exported values whose inferred
  types reach Foldkit-private schema aliases fail declaration emit in an example
  (`TS2742`); the fix is annotating with a public type, as `examples/sync` does
  with `Sync<Message, Shared>`. Either publish the missing public aliases (a
  nameable projection/definition type) or document the annotation pattern once.
- **Dynamic Model access should be safe by default.** `Optic.at` is a prism, so
  `optic.replace` on an absent key is a silent no-op (already in the trap list).
  A container-aware setter would make dynamic keys hard to get wrong.

## Smaller API notes

- **Remote's registry.** `Remote.make`'s `queries`/`mutations` now build a
  `registry`; use it to compile or validate server sources so its existence is
  load-bearing.
- **Sync subscription count.** `Replica.statusChanges` and `Presence.changes` are
  separate streams; a single `Replica.stream` for status + shared would cut the
  number of subscriptions a UI holds.
- **Agent adapter duplication.** The four adapters repeat tool listing, dispatch,
  and error mapping. A shared transport-mapping layer would keep them from
  drifting apart.
