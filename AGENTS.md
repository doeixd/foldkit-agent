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

## Traps already hit here

Every item below cost real time here. Check for them by name, and **add to this
list whenever you learn a durable lesson** -- one that would have saved the work
you just redid. Keep each to a couple of lines, with the concrete failure.

**External APIs**

- **Compile adapters against the real peer types.** The Agent Native README
  registration did not type-check: its tool requires an object schema, while
  our local descriptor only promised `Record<string, unknown>`.

- **Read the spec before writing the client, and again before writing its fake.**
  The WebMCP adapter passed the registration signal on the tool descriptor
  instead of in `registerTool`'s second argument, so unregistering did nothing.
  The test fake took one argument and asserted on `descriptor.signal`, so it
  confirmed the mistake instead of catching it. A fake authored from the same
  assumption as the code tests nothing. Make it reject what the real thing
  rejects.

- **Make the wire carry every field the client sends, with the same types.**
  `RemoteClient.live` sends `{ requirements, after }`, but the `LiveRequirement`
  payload omitted `after` and `LivePatch.cursor` was a `string` while the client
  cursor is numeric, so a real server could never answer the client's own call.
  The adapter is cast, so only diffing the client's request/response types against
  the payload/success schemas catches it.

**Library behaviour**

- **Give embedded Foldkit containers an id.** The runtime fails asynchronously
  before rendering when its container has no id; a DOM test otherwise sees only
  an empty element and hides the actual initialization failure.

- **Probe, do not assume, what a library type means.** `Schema.Struct({})` is
  not an empty-object schema: it accepts `{foo:1}`, `[]` and `"str"` even with
  `onExcessProperty: 'error'`. Use `Schema.Record(Schema.String, Schema.Never)`.
  Run a scratch probe against the installed version before relying on semantics
  inferred from a name.
- **Run the probe from the package, not the repo root.** A scratch probe run
  from the root resolves a different, v3-era `effect` than the pinned rc the
  package actually compiles against, so it answers a question about the wrong
  library and looks authoritative doing it. `cd packages/<name>` first.
- **Check the output, not just that the call returned.** `defineAction` accepts
  four different schema forms without complaint; three of them advertise a tool
  with no parameters at all. An API that takes your input and quietly produces an
  empty result is worse than one that throws.
- **Enforce what you advertise.** Deriving a JSON Schema that says
  `additionalProperties: false` is not validation; the decoder has to agree.
- **`Optic.at` cannot insert.** It is a prism, not a lens: `replace` is a no-op on
  an absent key, so writing a new key (or clearing one) needs a container-aware
  setter, not `optic.replace`. Silent no-op otherwise.
- **Untrusted field names are prototype keys.** `field in values` walks the
  prototype chain; filter with `Object.hasOwn` and accumulate with no prototype.
  The Drizzle adapter's relation/computed/column maps are `Object.create(null)`,
  and app-supplied policy/window lookups use `Object.hasOwn`, because
  `RemoteServer` passes client-chosen `fields` straight to `source.read`; a
  crafted `fields: ['__proto__']` otherwise misread `Object.prototype` as a
  relation and crashed the read.
- **Effect 4 `Rpc.make` streams via `stream: true`,** not `success:
  RpcSchema.Stream(...)`. Handlers come from `RpcGroup.toLayer`; the in-process
  test client is `RpcTest.makeClient(group)`.
- **Keep intermediate validators strict too.** Agent Native's Standard Schema
  stripped excess fields before dispatch, bypassing its strict decoder. Pass
  `parseOptions: { onExcessProperty: 'error' }` to `toStandardSchemaV1`.
- **Type a boundary from the side the runtime consumes.** Dispatch decodes, so
  its input type is the schema's *encoded* side. Typing it from the decoded side
  accepted `{value: 42}` and rejected the `{value: '42'}` that works.
- **Drizzle's Effect driver does not load under the pinned Effect.**
  `drizzle-orm@1.0.0-rc.4`'s `effect-postgres` driver imports
  `cache/core/cache-effect.ts`, which calls `Schema.TaggedErrorClass` — a name
  `effect@4.0.0-rc.112` does not export. A static import throws
  `Schema$1.TaggedErrorClass is not a function` and fails every test file that
  reaches it, not just the query. Require a Context tag and let the application
  provide the database; do not import the driver in library code until the two
  versions agree.

**Effect 4, not 3**

foldkit pins `effect@4.0.0-rc.112`. Names that moved, each found the slow way:
`Effect.either` -> `Effect.result`, `Effect.async` -> `Effect.callback`,
`Effect.timeoutFail` -> `Effect.timeoutOrElse`, `Duration.decodeUnknown` ->
`Duration.fromInputUnsafe`, `Schema.OptionFromSelf` -> `Schema.Option`. Check the
installed `.d.ts` before reaching for a remembered API.

**Types**

- **Capability names can be object prototype keys.** `__proto__` passes name
  validation but assigning it to `{}` loses the registry entry. Use a `Map` or
  a record with no prototype for capability lookups.

- **A message-free dynamic value does not widen by `never`.** `Mixin<never>` is
  not assignable to `Mixin<Message>`: `HtmlBuilder` is invariant in `Message`, so
  a function taking `ContributionContext<never>` rejects one taking
  `ContributionContext<Message>`. Name the message-free case in the accepted
  union (`Mixin<Message> | StaticMixin<Message> | Mixin<never>`) rather than
  expecting `never` to widen. A function that never mentions the Message universe
  does widen.

- **An `any` inside a generic silently disables checking.** `Parameters<>` of an
  intersection resolves to the last signature and widened every payload to
  `any`. A conditional inside a reverse mapped type is circular and quietly
  picks one branch, which let `input` without `toMessage` compile.
- **A function-typed property makes a generic invariant.** `EntityDescriptor.ref:
  (id: Type<F['id']>) => …` made `F` invariant, so a concrete `EntityBinding` was
  not assignable to `EntityDescriptor<any, any>` and `Remote.make({ entities:
  [binding] })` failed while `Selection.make(binding, …)` (which infers `F`)
  passed. Declaring `ref(id): …` as a method restores bivariance. Write the
  assignability case, not just the call that happens to infer.
- **Prove a type rejects, not just that it accepts.** Every constraint needs a
  `@ts-expect-error` negative case in `types.test-d.ts`. Both bugs above passed
  a suite full of positive cases.
- **Tie generics to the definition they belong to.** A host's Message type
  inferred independently of the contract let an incompatible host bind.
- **To type a callback from a sibling property, map over the inferred type, not
  over the keys you already know.** `expose`'s variants map was mapped over the
  Message tags, so `authorize`'s input could only be pinned to one type for
  every variant, and `any` was what kept `principal`/`model` inferable. Mapping
  over `keyof Ext` instead makes it a *reverse mapped type*: TypeScript infers
  one `Ext[Tag]` per variant from that variant's own `input` codec, then
  contextually types the callbacks beside it. A conditional is fine in the
  template (`Tag extends keyof C ? ... : never`) and in a callback parameter
  (`unknown extends Ext ? Payload : Ext`); it is only circular when the mapped
  type is F-bounded on the object being checked. The parameter must be
  `V & Mapped<...>` to keep `V` for the return type -- and an intersection is
  not excess-property-checked, so the unknown-key rejection has to move into the
  template.

- **Thread `Encoded`, not only `Type`, through a generic reference.**
  `ModelRef<Root, Value>` typed `Schema.Codec<Value, unknown>`, so a transforming
  field (`NumberFromString`) lost its encoded `string` through `Surface.pick`, and
  an assignability test could not see it (`unknown` accepts anything). Carry an
  `Encoded` parameter and pin it with a type-equality assertion.

- **An unused parameter or config field is a promise the runtime does not keep.**
  `RemoteServer.make(Data, …)` never read `Data`, and `Remote.make` accepted
  `queries`/`mutations` it dropped, so the API advertised a relationship that did
  not exist. Type it and use it, or delete it.

- **Do not make a caller reconstruct a key the library owns.** `Remote.live` took
  a `cursor` callback, but the stream key was internal, so the application could
  not compute it; the fix was for the library to read its own state. If a caller
  would need library internals to satisfy an argument, the library should read
  them itself.

**Async**

- **Re-check invariants after every `await`.** A `disposed` flag read once
  before two awaits still registered tools after disposal.
- **Ask what else can run while you are suspended.** Moving bookkeeping after
  an await fixed a false-success bug and introduced double registration;
  overlapping passes had to be serialized.
- **Subscribe before the action that can produce the event.** `update` can emit a
  completing Message synchronously, so a listener attached after the dispatch
  misses it and then waits for its timeout.
- **Guard fire-and-forget work.** An un-awaited reconcile turned a failure into
  an unhandled rejection.
- **`Effect.result` captures failures, not defects.** At an edge that must not
  throw, catch as well.

**Tests**

- **A surviving mutation usually means redundancy, not missing coverage.** This
  has now happened three times: overlapping disposal guards, then a `release()`
  duplicating an `Effect.ensuring`. The fix is to delete the redundant guard, not
  to write a test for a window that does not exist. One guard per window, one
  test per guard.
- **Verifying by hand is not coverage.** `Agent.pick`'s snapshot bug was
  confirmed in a scratch script and shipped without a test.

**Tooling**

- **Vite 5 does not recognize `node:sqlite` as a builtin.** A static import
  under Vitest is rewritten to a bare `sqlite` and fails to load;
  `test.server.deps.external` does not help because resolution happens first.
  `vitest.config.ts` aliases `node:sqlite` to `test-support/sqlite.ts`, so a
  normal static import works in Vitest and tsx. Do not reinstate per-file
  `createRequire`.

- **Format with `pnpm format`, never bare `prettier`.** The config matches the
  style already in the tree; without it prettier rewrites files to its own
  defaults. Markdown is deliberately ignored, because prettier pads table
  columns and reformats code inside fenced blocks, rewriting the documents'
  illustrative snippets.
- **`@ts-expect-error` is anchored to the next line.** Reformatting wrapped a
  long call and left two directives pointing at a line that no longer errors, so
  the assertions silently stopped asserting. Put the directive immediately above
  the offending expression, not above a call that contains it, and re-run
  `pnpm typecheck` after formatting.
- **Bulk edits replace every occurrence, and a missing anchor fails silently.** A
  scripted insert landed in two functions and broke an unrelated one; a later one
  matched nothing and quietly did not apply, so a field was simply absent. Assert
  the anchor, then re-read the diff -- not just the check.
- **Run the CI sequence before committing, not after.** `format:check`,
  `typecheck`, `test`, `demo`. A commit shipped that would have failed
  `format:check` because only the last three were run.
- **`pnpm ci` is a pnpm builtin, not your script.** A root script named `ci`
  never runs (`ERR_PNPM_CI_NOT_IMPLEMENTED`). The full-check script is `check`:
  run `pnpm check`.
- **Map every workspace dep in a composite example's `paths`.** A package's
  `tsconfig.build.json` emits to `.tsbuild/build`, not `dist`, so resolving an
  import through `exports` fails on a clean checkout; a stale local `dist` hides
  it and only CI's `typecheck:force` goes red. `examples/kitchen-sink` omitted
  `foldkit-remote-drizzle` and failed with `Cannot find module` plus cascading
  `unknown` types. Diff the example's `paths` against its `workspace:` deps.

## Repository

- Workspace: pnpm, `packages/*` and `examples/*`.
- Build: `tsdown`. Tests: `vitest`. Types: `tsc -b`. Format: `prettier`.
- CI runs `format:check`, `typecheck`, `test`, and `demo` on push and PR. Run
  the same four locally before committing.
- `PLAN.md` is git-ignored and tracks in-progress work.
