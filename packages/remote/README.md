# `foldkit-remote`

Normalized application-facing server state for Foldkit. Entities, field
selections, queries, connections, mutations, and live patches reconcile into one
store that is part of the Model. There is no hidden mutable cache: the same
`update` that moves the application moves remote data.

`foldkit-remote` owns semantic data modeling; Effect owns the infrastructure
below it. The wire is Effect RPC (`RemoteRpc`), so the transport is whatever
Effect layer the application chooses — HTTP, WebSocket, worker, in-process.
The server half is
[`foldkit-remote-server`](https://github.com/doeixd/foldkit-plus/tree/main/packages/remote-server).
The worked end-to-end trace is
[`examples/remote`](https://github.com/doeixd/foldkit-plus/tree/main/examples/remote).
The full design rationale is in
[Revision Plan §8](https://github.com/doeixd/foldkit-plus/blob/main/docs/design/REVISION_PLAN.md#8-remote).

## Quick start

### Entities, selections, and operations

```ts
import { Schema } from 'effect'
import { Entity, Mutation, Query, Remote, RemoteData, Selection } from 'foldkit-remote'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))

const Project = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    status: Schema.String,
    owner: Entity.ref(User),
  }),
)

const UserSummary = Selection.make(User, { id: true, name: true })
const ProjectSummary = Selection.make(Project, {
  id: true,
  name: true,
  status: true,
  owner: UserSummary,
})

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection(Project),
})

const RenameProject = Mutation.make('RenameProject', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})
```

A relation is a reference codec (`Entity.ref(User)`), never an inline target
schema, so a recursive relation such as `Node.parent: Entity.refTo('Node')` needs
no inlining and the entity type stays finite. `Selection.make` infers the picked
Struct; an unknown field is a compile error.

A nested selection reads **through** a relation into its target, and takes the
field's shape: a ref reads as the nested value, a nullable ref as the value or
`null`, an array of refs as an array, and a page of refs
(`Selection.connection(Entity, window, nested)`) as a `Page` of items;
`Selection.connection(Entity, window)` alone reads the page of refs. The cache
stays normalized (`Project:p1.owner` is a ref to `User:u7`), the requirement
carries the whole graph (`relations`), and one read resolves it: the server
follows each level's refs into the next, fetching a target several relations
share once and authorizing every level through its own entity source. A
selection on a scalar field throws at construction, and a recursive relation
stays finite because the selection, not the entity, drives traversal.

### Declare the domain and embed its submodel

```ts
const Data = Remote.make({
  entities: [User, Project],
  queries: [ProjectsByOwner],
  mutations: [RenameProject],
})
// Data.Model, Data.initial, Data.Message, Data.update, Data.rpc

const Model = Schema.Struct({ route: Route, remote: Data.Model })
const Message = defineMessageUnion({ Ping: {}, GotRemote: { message: Data.Message } })

const App = Surface.application({
  Model,
  Message,
  initial: { route: Route.home(), remote: Data.initial },
  update: (model, message) => {
    switch (message._tag) {
      case 'GotRemote':
        return { model: { ...model, remote: Data.update(model.remote, message.message) } }
      case 'Ping':
        return { model }
    }
  },
})

const AppRemote = Remote.at(Data, App.model.remote)
```

`Data.update` is the one reducer for every producer of new facts: a read batch, a
mutation result, a live event, a connection merge, or an optimistic layer. The
application wraps `RemoteMessage`s in its own Message union rather than adding
`ReceivedBatch` and friends to it.

### Read in a Surface

```ts
const ProjectPage = Surface.make(App, 'ProjectPage', {
  Params: Schema.Struct({ projectId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({
      project: Remote.select(AppRemote, ProjectSummary)(params.projectId),
    }),
  messages: [Message.Ping],
})
```

`Remote.select` returns a `Projection<AppModel, RemoteData<ProjectSummary>>` that
reads the store purely:

- `Initial` — some selected field is not present yet,
- `Ready` — present,
- `Refreshing` — present, and an observer is refetching a selected field under a
  refreshing policy (below),
- `Failed` — the assembled value did not decode against the Selection,
- `NotFound` — the entity is a tombstone.

`RemoteData.match` is exhaustive; `RemoteData.map`, and `RemoteData.schema` for
embedding the state in a hand-written Model, are also exported.

`Remote.select` is constrained to the domain's registered entity names, so a
selection for an entity `Data` never declared does not compile.

## Observation

Reading is pure; fetching is a Foldkit Subscription derived from the Surface.

```ts
const subscriptions = (model: Model) => [
  Remote.observe(AppRemote, ProjectPage, { projectId: model.route.projectId }, message =>
    Message.GotRemote({ message }),
  ),
  Remote.live(AppRemote, ProjectPage, { projectId: model.route.projectId }, message =>
    Message.GotRemote({ message }),
  ),
]
```

`Remote.observe` plans the Surface's missing fields against the store and fetches
only those; a fully-known Surface emits nothing. A read failure and a live stream
break both arrive as `RemoteMessage`s (`ReadFailed`), so one handler covers
success and failure. `Remote.live` resumes from `RemoteModel.live`, so the
application tracks no cursor.

### Policies

A `RemotePolicy` decides what a field the store already holds means:

```ts
Remote.observe(AppRemote, ProjectPage, params, toMessage, {
  policy: RemotePolicy.staleWhileRevalidate({ maxAge: 30_000 }),
})
```

- `RemotePolicy.cacheFirst` (default) — fetch only missing, stale, or
  re-windowed fields.
- `RemotePolicy.staleWhileRevalidate({ maxAge })` — keep present values
  visible and refetch an entry older than `maxAge` milliseconds.
- `RemotePolicy.networkOnly` — fetch every selected field regardless of
  coverage; cached values stay visible meanwhile.

A refreshing policy emits `RefreshStarted` before the read. `Remote.update` marks
the refetched fields stale, so `Remote.select` reads them as `Refreshing` until
`ReadReceived` lands. The policy compiles to planner options
(`RemotePolicy.toPlan`); the planner stays pure, and the clock it reads is the
`now` option (default `Date.now`), so tests inject time.

Lower-level, pure planning is available when a Surface is not the right unit:

```ts
Remote.planProjection(store, projection, options?)  // -> Requirement[]
Remote.observeProjection(AppRemote, model, projection, options?)
Remote.planSurface(AppRemote, model, ProjectPage, params, options?)
```

`options` is a `PlanOptions`: `freshness` (`{ now, freshness }`) refreshes an
entry older than the window, `force` plans every field.

`Requirement` is plain data — entity, id, fields, and per-relation windows — so a
plan can be inspected, serialized, diffed, or shown in DevTools.

`Remote.prefetch` runs the same plan through `RemoteClient` and returns the new
store; use it for SSR, route/hover prefetch, and tests. It never runs during
render.

```ts
const store = await Effect.runPromise(
  Remote.prefetch(AppRemote, model, Projection.struct({ project }), {
    policy: RemotePolicy.staleWhileRevalidate({ maxAge: 30_000 }),
  }).pipe(Effect.provide(clientLayer)),
)
```

`prefetch` takes the same `policy` and `now` options as `observe`.

### Coalescing

Reads through `Remote.clientLayer` coalesce: requirements issued together
become one `ReadBatch` (ids batched, overlapping fields unioned), a requirement
already in flight is joined rather than re-requested, and a failed read releases
it. Every waiter receives the whole batch result; `Remote.update` writes it
idempotently. `Remote.coalesced(layer, { window })` wraps a hand-written client
the same way; `window` widens the batching delay beyond "issued concurrently".

### Retention

The cache keeps what the active Surfaces reach:

```ts
const subscriptions = (model: Model) => {
  const page = ProjectPage.projection({ projectId: model.route.projectId })
  return [
    Remote.observe(AppRemote, ProjectPage, { projectId: model.route.projectId }, toMessage),
    Remote.retain(AppRemote, [page], toMessage, {
      connections: [projectsRef.identity],
      grace: '5 seconds',
    }),
  ]
}
```

`Remote.retain`'s dependencies are the roots (the listed projections'
requirements plus the named connections); it emits `RetentionChanged` once the
roots have been stable for `grace`, and a root change restarts the wait, so a
route transition that comes straight back does not thrash. `Remote.update`
applies the pure `gc(state, roots)`: a root entity, the targets its retained
fields refer to, the targets a nested relation selects, a retained connection's
edges, and anything a pending optimistic layer or overlay touches survive;
everything else is dropped. Roots live outside the Model, so GC is a Message
like every other cache change.

## Mutations

```ts
// In update, issued as a Command:
Remote.mutateInto(AppRemote, model, RenameProject, { id, name }, requestId)
// Effect<{ output: { id: string }; model: Model }, RemoteMutationError, RemoteClient>
```

`Remote.mutate` is the lower-level form. It decodes the typed `Output` **and**
returns the result's normalized `entities`, so a caller that manages its own
Messages can reduce them through `Remote.update`:

```ts
Remote.mutate(RenameProject, { id, name }, requestId)
// Effect<{ output: Output; entities: readonly NormalizedPatch[] }, RemoteMutationError, RemoteClient>
```

A `MutationSucceeded` message reconciles the patches at most once per
`requestId`, so a transport retry cannot apply the same change twice; an unknown
or already-applied result is a no-op.

### Optimistic updates

Optimistic changes are ordered layers over the base store, not inverse patches:
the visible store is recomputed, and settling removes the layer, so overlapping
layers rebase for free.

```ts
Data.update(model.remote, {
  _tag: 'OptimisticAdded',
  layer: { id: requestId, patches: [{ entity: 'Project', id, values: { name } }] },
})
```

`MutationSucceeded` writes the server's patches and removes the layer;
`MutationFailed` removes the layer, revealing the base.

## Connections

A connection stores entity references with explicit known boundaries, not a flat
array plus `hasNext`, so an unloaded middle page is a gap rather than an implied
adjacency. Pages, live inserts, and optimistic inserts are all evidence about the
same structure and merge through one pure reducer:

```ts
Remote.update(remote, { _tag: 'ConnectionMerged', connection: 'ProjectsByOwner(...)', page })
```

`items`, `hasNext`, `hasPrevious`, and `isGapped` read the server-known region;
`visibleItems` places optimistic overlays outside it. `ConnectionInvalidated`
marks a connection stale and `ConnectionRefreshed` clears it once a fresh page is
adopted.

## Queries

A `QueryRef` is a server list/search operation with a canonical identity (the
descriptor plus the encoded input, excluding the window). `Remote.query` runs it
through `RemoteClient`, and `Remote.queryMessage` turns the page into a
`ConnectionMerged` message for `Remote.update`:

```ts
const ref = Query.first(25)(ProjectsByOwner.ref({ ownerId }))
const page = yield* Remote.query(ref)
yield* Effect.sync(() =>
  dispatch({ _tag: 'GotRemote', message: Remote.queryMessage(ref, page) }),
)
```

The connection key is `ref.identity`, so `first(25)` and `after(cursor).first(25)`
merge into one connection.

## Introspection

`Remote.inspect(model)` returns a serializable summary of the cache — entities
with their present/stale fields, connection keys, live streams, gaps, and the
mutation ledger — and `Remote.inspectEntity(model, key)` returns one entity. Both
are pure, so DevTools never reach into the private layout.

## Live data

`Remote.live` consumes an Effect streaming RPC. Events carry a monotonic cursor
per stream: duplicates are ignored, and an event ahead of the cursor is a gap —
it is not applied, and the stream is recorded in `RemoteModel.gaps` so the host
can resync rather than silently miss facts. The gap clears when an in-order event
applies, or on a `GapCleared` message. An `EntityPatched` updates the store;
`EntityDeleted` writes a tombstone; `ConnectionInsert`/`ConnectionRemove`/
`ConnectionInvalidate` change connection membership and ordering.

## Persistence

```ts
RemotePersistence.save(store, { key: 'remote-cache' })
RemotePersistence.restore({ key: 'remote-cache' })
```

Both require Effect's `KeyValueStore`, so the backend (memory, filesystem, Web
Storage, SQL) is the application's choice. The cache is server-derived and
disposable: a version mismatch or malformed snapshot is discarded and the
planner refetches.

## What it owns

- **Entity identity and references.** `Entity.make`, typed `EntityRef`s, and
  reference codecs; `Entity.patch` types a patch against the entity's fields.
- **Field selections.** `Selection.make` derives a Struct from the picked fields
  and rejects unknown ones; a nested selection reads through a relation, and
  the requirement carries the graph so one read resolves it.
- **The normalized store.** Values, per-field presence, staleness, and tombstones
  are tracked separately, so `undefined`, `null`, absent, stale, and not-found
  are distinct. Presence is never inferred from `value === undefined`.
- **The requirement planner.** `Remote.plan*`/`plan` diff requirements against the
  store and return only missing or stale fields, deterministically.
- **The Remote submodel.** `Remote.make` returns `Model`, `initial`, `Message`,
  `update`, `rpc`, and a name-keyed `registry` of the declared entities, queries,
  and mutations (consumed by `RemoteServer.validate` and available to tooling);
  `Remote.update` is the single reducer over reads, mutation results, live
  events, connections, and optimistic layers.
- **Mutation reconciliation.** Idempotent per `requestId`, with a bounded
  settled-request ledger.
- **Connections.** Segmented ordered data with explicit boundaries and overlay
  placement.
- **Queries.** `Remote.query(ref)` encodes and runs a `QueryRef`; 
  `Remote.queryMessage(ref, page)` merges the result into the connection keyed by
  `ref.identity`.
- **Live classification.** Per-stream cursor ordering, duplicate suppression, and
  gap detection; a gap clears when an in-order event applies or a `GapCleared`
  message arrives.
- **Introspection.** `Remote.inspect` and `Remote.inspectEntity` return a pure,
  serializable cache view for DevTools.
- **The transport seam.** `RemoteClient`, an Effect service with `read`, `query`,
  `mutate`, and `live`; the wire schemas and `RemoteRpc` group.
  `Remote.clientLayer(rpcClient)` adapts an Effect RPC client for `RemoteRpc` to
  `RemoteClient`, including the `LiveChange`-to-`LiveEvent` mapping.
- **Disposable cache persistence.** Snapshot encode/decode over `KeyValueStore`.

## Limits

- The transport is not part of the package. Effect RPC is the wire; the
  application supplies the client and server protocol layers. `ReadBatch` and
  `LiveRequirement` name `REMOTE_PROTOCOL_VERSION`; a server refuses another
  version with `RemoteProtocolError`, so a wire change is a version bump, never
  silent drift.
- A nested connection's page is merged onto the stored page only when it is a
  top-level requirement; "load more" through a nested relation refetches the
  page.
- The wire `LiveChange` union carries entity patches, deletes, and connection
  insert/remove/invalidate changes; the client adapter reconstructs a `LiveEvent`
  from it. `RemoteServer.live` serves them as a stream.
- Coalescing is per `RemoteClient` layer: two Remote domains with separate
  layers do not share a batch. `Remote.retain` collects only what the
  application lists; a Surface it does not list loses its data on the next
  `RetentionChanged`.
- `RemoteData` is a closed union.
