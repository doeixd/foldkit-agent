# High-level Foldkit Sync DX

Status: proposal for [#59](https://github.com/doeixd/foldkit-plus/issues/59).
The low-level `defineSync` protocol stays as-is; this describes the Foldkit-facing
layer above it. Nothing here is implemented yet.

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
const TodosSync = Sync.forApplication({
  Model,
  Message,
  initial: initialModel,
  update,

  shared: Sync.pick(Model, ['todos']),

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

## `Sync.pick`: the shared projection

`Sync.pick(Model, keys)` infers a projection from the Model struct:

```ts
interface Projection<Model, Shared> {
  readonly schema: Schema.Codec<Shared, SharedEncoded>
  readonly get: (model: Model) => Shared
  readonly set: (model: Model, shared: Shared) => Model
}
```

- `schema` is `Schema.Struct` over the picked fields, so its encoded side is the
  shared codec the replica already needs.
- `get`/`set` are derived from the field list, so `Sync.pick(Model, ['todos'])`
  produces `{ todos: Model['todos'] }` with no annotation.
- A picked key that is not in the Model is a compile error.
- For a computed projection, `Sync.state({ schema, get, set })` is the escape
  hatch; `get`/`set`/`schema`/`Model` mutually constrain.

The initial shared value is `get(initial)`, so no separate `empty` is written.

## Derived replay

This is the whole point: the user never writes `replay`.

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

The two guards are exactly what `examples/sync/src/app.ts` does by hand today;
they move into the library. Failure is a typed development error naming the
offending field, not a silent divergence. If Foldkit ever exposes a transition
driver that can reject a transition before it applies, this is where it plugs in;
until then, deterministic replay plus these guards is the contract.

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
    Sync.shared(Sync.pick(Model, ['todos'])),
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

`Sync.forApplication` and `Agent.for`/`Agent.define` should consume the same
Model/Message references so domain behaviour is specified once. A durable agent
capability can reuse the synchronized Message classification:

```ts
Agent.expose(Message.RenamedTodo).pipe(Agent.remote(Sync.durable(Message.RenamedTodo)))
```

Exact syntax is open; duplicated schemas, reducers, or action lists are not.

## Invariants

Compile-time: variants belong to the union; payloads are exact in hooks; picked
Model keys exist; projection `get`/`set` agree with `schema`; composition rejects
contradictions; adapter needs are in Effect environment types.

Development-time: a durable transition mutates local-only state; a durable replay
depends on ambient nondeterminism; a presence transition mutates durable state; a
durable transition produces a prohibited Command.

## Milestones

1. **`Sync.pick`** — projection with inference and negative type tests. No
   Foldkit dependency; useful on its own.
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
tags, composable fragments, exact payload inference, and browser/server adapters
over one contract, with negative type tests.

## Open questions

- Object form vs `.pipe` combinator form for the declaration (recommendation:
  ship the object form, add combinators for fragments once needed).
- Where `Sync` lives: a `foldkit-sync` namespace export, or a `foldkit-sync/foldkit`
  entry point that can take a `foldkit` peer dependency. The protocol core should
  not import Foldkit.
- Whether `Sync.forApplication` takes a Foldkit application object (once one
  exists) or the four pieces (`Model`, `Message`, `initial`, `update`).
- How `presence` reuses the authenticated peer identity the server already has.
