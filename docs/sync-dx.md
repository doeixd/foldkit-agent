# High-level Foldkit Sync DX

Status: proposal for [#59](https://github.com/doeixd/foldkit-plus/issues/59).
The low-level `defineSync` protocol stays as-is; this describes the Foldkit-facing
layer above it. The initial `pick` primitive exists in `foldkit-sync`; the
high-level constructors and adapters below remain proposals.

## Shared foundation with agent projections

The [surface design](../packages/agent/DESIGN.md#shared-projection-foundation)
places application references, state projections, typed Message subsets, and
structural composition in `foldkit-surface`. Agent and sync should consume these
same primitives rather than grow independent projection systems. Sync's initial
`pick` is a starting implementation to consolidate with `Agent.pick`, preserving
compatible entry points during migration.

The default field selection is reference-based:
`Surface.pick(App.fields.todos)`, with `Sync.forApplication(App, options)` and
`Agent.forApplication(App)` consuming the same application reference. See the
[usage sketches](../packages/agent/DESIGN.md#usage-sketches-across-packages) for a
single projection used as agent context and replicated state, then bound to
browser and server instances.

Agent only needs a projection's codec and read; sync additionally requires a
lawful install into the Model. A read-only computed agent summary must not be
given an invented inverse to satisfy sync. Reusing a projection does not imply
shared state is public or durable Messages are agent-invocable: each package
still declares its policy explicitly. Surface's pure core remains independent
of DOM, storage, transport, and these specialized policies.

## Why two layers

`defineSync({ message, shared, empty, durable, replay })` is the right
protocol/replica primitive, but it asks an application author to restate what
Foldkit already knows — the Model schema, the shared projection, which Messages
are durable, and a `replay` that can drift into a second reducer. The high-level
API should compile down to that primitive, not replace it:

```text
Foldkit application  (Model + Message + update)
        |
        v
Foldkit Sync projection   Sync.forApplication(...)   <- this proposal
        |
        v
protocol contract        defineSync(...)             <- exists today
        |
        v
replica / storage / transport / presence             <- exists today
```

Non-Foldkit consumers keep using `defineSync` directly.

## Properties the API must have

1. **Single-source.** `update` is the only transition function; no `replay`.
2. **Inferred.** Normal use needs no explicit generics, casts, or duplicate
   schemas. The shared shape comes from the Model; payloads come from the Message
   variant references.
3. **Reference-based.** Classify `Message.RenamedTodo`, not the string
   `'RenamedTodo'`.
4. **Composable.** Independent feature fragments contribute fields and Messages;
   composition preserves types and rejects conflicts.
5. **Effect-native.** A pure contract value plus `Layer`s at environment
   boundaries; adapters do not leak into the domain declaration.
6. **Adapter-neutral.** The same contract feeds browser sync, a server replica,
   agents, and MCP.
7. **Progressively adoptable.** A small app needs very little; advanced apps opt
   into custom projections, authorization, merge helpers, and adapters.

## Proposed surface

A declaration that compiles to `defineSync`:

```ts
const App = Surface.application({
  Model,
  Message,
  initial: initialModel,
  update,
})

const TodosSync = Sync.forApplication(App, {
  documentId: documentId('todos'),
  shared: Surface.pick(App.fields.todos),

  durable: [Message.CreatedTodo, Message.RenamedTodo, Message.DeletedTodo],
  presence: [Message.SelectedTodo],
})
```

Everything omitted is `local`. The result is a contract value, not a running
replica:

```ts
// Browser
Sync.browser(TodosSync, { storage, transport })
// Server
Sync.server(TodosSync, { journal, principal })
```

Both adapters consume the same `TodosSync`; the contract has no WebSocket,
IndexedDB, SQLite, or agent types in it.

The issue also sketches an Effect-style `.pipe(Sync.shared(...), Sync.durable(...))`
form. That is worth supporting later if fragments need it; the object form is
easier to infer and read for a first release, so it is the recommendation.

## Reference-based state projection

`Surface.pick(App.fields.todos)` infers a projection from generated field
references on the application's Model. `App.fields` is derived once, so authors
write neither path strings nor a parallel field registry:

```ts
interface Projection<Model, Shared, SharedEncoded> {
  readonly schema: Schema.Codec<Shared, SharedEncoded>
  readonly get: (model: Model) => Shared
  readonly set: (model: Model, shared: Shared) => Model
}
```

- `schema` is `Schema.Struct` over the picked fields, so its encoded side is the
  shared codec the replica already needs.
- `get`/`set` are derived from the references, so `Surface.pick(App.fields.todos)`
  produces `{ todos: Model['todos'] }` with no annotation.
- A missing field is a compile error at `App.fields.missingField`.
- For a computed projection, `Surface.state({ schema, get, set })` is the escape
  hatch; `get`/`set`/`schema`/`Model` mutually constrain.

The initial shared value is `get(initial)`, so no separate `empty` is written.

Select several fields as `Surface.pick(App.fields.todos, App.fields.members)`
when both exist. A field reference carries owner, path, and codec; raw schema
identity alone is insufficient because several fields can reuse one schema.
Nested selection should use typed references with explicit optional-parent
semantics, not dot-separated strings. Picks must snapshot their references and
write only selected fields. Static source-type checks and definition-time owner
checks prevent unrelated applications from being mixed merely because their
field shapes happen to match.

The initial `foldkit-sync` export `pick(Model, keys)` and existing `Agent.pick`
remain compatibility APIs while their internals converge on surface. A string-key
surface API, if offered, is explicit opt-in and still constrained to valid keys;
it is not the default shown in new application examples.

## Derived replay

For the supported state-only subset, the user does not write `replay`.

```text
shared snapshot
      |
      v
baseline Model = set(initial, shared)      // local fields at their initial values
      |
      v
result = update(baseline, message)
      |
      +-- reject Commands (a durable transition is state-only)
      +-- assert non-shared fields still equal initial's non-shared fields
      |
      v
get(result.model)
```

`Sync.forApplication` applies both guards; `examples/sync` no longer carries a
hand-written copy. Failure is an error naming the Message and the offending
fields, not a silent divergence, and the refused Command's effect never runs. If Foldkit ever exposes a transition
driver that can reject a transition before it applies, this is where it plugs in;
until then, deterministic replay plus these guards is the contract.

These guards cannot prove independence from local state or arbitrary JavaScript
purity. An update can read local selection to choose a shared entity without
writing any local field. Such a Message must carry the target explicitly, or the
application must restructure its transition before using derived replay. Custom
projections also need lawful get/set behavior. Unsupported cases keep the
low-level `defineSync` escape hatch rather than a fabricated replay guarantee.

## Classification and composition

- `durable: [Message.X, ...]` and `presence: [Message.Y, ...]` take variant
  references. A reference outside the Message union is a compile error.
- Per-variant policy attaches to the reference and infers the payload:

  ```ts
  Sync.durable(Message.RenamedTodo, {
    authorize: ({ principal, message, model }) => principal.canRename(message.id),
  })
  ```

- Fragments compose:

  ```ts
  const Todos = Sync.fragment(App).pipe(
    Sync.shared(Surface.pick(App.fields.todos)),
    Sync.durable(Message.CreatedTodo, Message.RenamedTodo),
  )
  const Presence = Sync.fragment(App).pipe(Sync.presence(Message.SelectedTodo))
  const Collaboration = Sync.compose(Todos, Presence)
  ```

  Composition rejects a Message classified both durable and presence, two
  incompatible definitions of one Message, and inconsistent principal
  requirements. Disjoint shared fields merge automatically.

## Adapters

The contract is a value; adapters are `Layer`s:

```ts
const Browser = Sync.browser(TodosSync, { storage: StorageLive, transport: TransportLive })
const Server = Sync.server(TodosSync, { journal: JournalLive, principal: PrincipalLive })
```

`Sync.browser` wires `openReplica`/`synchronize`/`close` and the Foldkit runtime
mount; `Sync.server` wires the durable journal, authorization, and effect
settlement. Keeping them separate is what lets one contract serve a browser
replica, a server replica, and an agent producer.

The runtime mount currently lives in `examples/sync/src/runtime.ts`; it becomes
`Sync.mount`/`Sync.browser` rather than example glue.

## Effect and agent composition

`Sync.forApplication` and `Agent.forApplication` consume the same surface
application and projection references so domain behaviour is specified once.
A durable agent capability can reuse synchronized Message references while
declaring its agent exposure explicitly:

```ts
Agent.expose(Message.RenamedTodo).pipe(Agent.remote(Sync.durable(Message.RenamedTodo)))
```

Exact syntax is open; duplicated schemas, reducers, or action lists are not.

## Invariants

Compile-time: variants belong to the union; payloads are exact in hooks; field
references exist and their source types agree; projection `get`/`set` agree with
`schema`; composition rejects contradictions; adapter needs are in Effect
environment types.

Development-time: a durable transition mutates local-only state; a presence
transition mutates durable state; a durable transition produces a prohibited
Command. Property tests should exercise determinism and projection laws, but
runtime guards cannot prove absence of ambient nondeterminism or local reads.

## Milestones

1. **Shared projection primitives** — consolidate the initial sync `pick` and
   agent's read projection under surface, preserving entry points. Prove codec
   inference, immutable declarations, get/set behavior, and composition with
   runtime and negative type tests; no DOM or storage dependency in this core.
2. **`Sync.forApplication`** — derive `empty`, the durable predicate, and
   `replay` from `Model`/`Message`/`initial`/`update`; still returns a
   `SyncDefinition` fed to `defineSync`. Reference-based classification.
3. **`Sync.mount` / `Sync.browser`** — fold `examples/sync/src/runtime.ts` into a
   first-class adapter, driven by the example.
4. **Fragments and composition** — `Sync.fragment`/`Sync.compose` with conflict
   detection.
5. **`Sync.server`** — journal + authorization + effect settlement over the same
   contract.
6. **Agent reuse** — one Model/Message vocabulary for sync and agent capabilities.

Acceptance for the whole issue: the example expresses its sync configuration with
no explicit generics, no `as`, no duplicated Message schema or reducer, no string
field paths or Message tags by default, composable fragments, exact payload
inference, and browser/server adapters over one contract, with negative type tests.

## Options considered

### Where the Foldkit adapter lives

- **Root export with an optional `foldkit` peer.** One import, but the root
  `.d.ts` would reference `foldkit` types for consumers who never use it, and the
  protocol core stops being Foldkit-free.
- **`foldkit-sync/foldkit` subpath with a `foldkit` peer — recommended.** The root
  keeps `defineSync`, the replica, transport, presence, and the schema-only
  `pick`; the subpath carries the Foldkit DX and re-exports `pick`. This matches
  the repo: the `foldkit-agent*` packages peer on `foldkit`, while
  `foldkit-durable` and `foldkit-sync` peer only on `effect`.
- **A separate `foldkit-sync-foldkit` package.** Cleanest boundary, but another
  package to version and publish for little gain over a subpath, and it weakens
  the "one contract, several adapters" story.
- **Inside `foldkit-agent`.** No: replication is not agent-specific.

### Declaration shape

- **Object form — recommended.** One inference site for `Model`/`Message`; the
  remaining fields are checked against it. Large apps compose with
  `compose(fragmentA, fragmentB)` over partial declaration objects rather than a
  fluent builder.
- **Fluent `.pipe` combinators.** Idiomatic, but each combinator must thread an
  accumulating contract type, and combined with Effect Schema's service generics
  it tends to need explicit type arguments and reads poorly in errors. Add it
  only if fragments need it.

### Deriving replay

`foldkit`'s application config already carries `init` and `update`, and `update`
returns `Update.Return<Model, Message> = { model, commands? }`, so `replay` is
derivable without the user writing it:

```text
baseline = projection.set(initial, shared)
result   = update(baseline, message)
guard    result.commands is empty          // a durable transition is state-only
guard    model equals projection.set(initial, projection.get(result.model))
         // update changed only shared fields: writing the projection back into
         // the baseline reproduces the result exactly
return   projection.get(result.model)
```

The second guard is the general form of the example's destructuring check — if
`update` touched a local field, the projection written back into the baseline
differs — so it needs no field enumeration and works for a custom projection.
`Schema.toEquivalence(Model)` supplies the comparison.

`initial` is an explicit `Model`, not `init()`: a routing app's
`init(flags, url)` has no single initial model, and the shared baseline must not
depend on the URL.

### Classification

`Message.CreatedTodo` is a callable `TaggedStruct` carrying `_tag` (a
`Schema.tag<'CreatedTodo'>`), and `defineMessageUnion` returns `guards`,
`subset`, and `match`, so reference-based classification reads the tag from the
constructor. Typing `durable` against the union's constructors rejects a
reference from another union (a negative type test pins it). Omitted is `local`.
`presence` is a classification the adapter consumes; `defineSync` still takes
only the durable predicate, so the protocol layer is unchanged.

### Mounting the runtime

`examples/sync/src/runtime.ts` works by adding `RefreshShared`/`PersistenceFailed`
to a wrapping `RuntimeMessage` union, persisting a durable Message in a Command,
and installing the projection when it resolves. Generalizing it needs the app's
Message union to include those internal variants, or a Foldkit dispatch seam that
can await persistence before applying the transition.

- **App-declared internal variants — recommended for now.** A `Sync.mount` that
  takes the app's runtime Message union and documents the two required variants.
  Works today with no upstream change.
- **A Foldkit transition driver / admission hook.** The clean answer and the one
  #42 points at, but it is an upstream change. Propose it separately; do not
  block the DX on it.

`Sync.browser` only needs `openReplica`/`synchronize`/`close`, so it ships before
the mount is generalized.

## Remaining questions

- Finalize the `foldkit-sync/foldkit` subpath and migration of the existing root
  `pick(Model, keys)` export to surface internals. Reference-based selection is
  the default in the new API; string keys remain a compatibility/opt-in form.
- How a durable transition that returns an `OutMessage` (a submodel) is treated:
  rejected like a Command, or allowed.
- How `presence` reuses the authenticated peer identity the server already has.
