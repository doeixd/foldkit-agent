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
it. Requirements that page nothing share one read and every waiter may write
its whole result, since plain values are the same whoever asked; a requirement
that pages a relation anywhere in its graph reads alone, because a page
answers exactly one window. `Remote.coalesced(layer, { window })` wraps a
hand-written client the same way; `window` widens the batching delay beyond
"issued concurrently".

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
edges, and anything a pending request's layer or overlays touch survive;
everything else is dropped, settled overlays on a dropped connection included. Roots live outside the Model, so GC is a Message
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

A Remote mutation is an immediate, server-derived command: it runs now, against
the server that owns the data, and its result is cache. It is not durable
intent. An edit that must survive the process or the network (offline writes,
a queue that replays later, convergence between replicas) belongs to
`foldkit-sync` and `foldkit-durable`, which already own an ordered log and its
idempotency; Remote adds no second queue. If a bridge is ever needed, it turns a
durable operation into a Remote mutation when it replays, not the other way
round.

### Optimistic updates

A mutation owns its optimistic operations: entity patches and connection
changes, applied together when it starts and released together when it settles.

```ts
// In update, before issuing the Command:
Data.update(model.remote, {
  _tag: 'MutationStarted',
  requestId,
  optimistic: [
    Entity.patch(Comment.ref(tempId), { id: tempId, body }),
    Optimistic.prepend(commentsRef, Comment.ref(tempId)),
  ],
})
```

Patches are ordered layers over the base store, not inverse patches: the visible
store (`visibleStore`) is recomputed, and settling removes the layer, so
overlapping layers rebase for free. Connection changes (`Optimistic.prepend`,
`append`, `remove`) are overlays outside the server-known region; `visibleItems`
places inserts newest-first and hides a removed edge until a later insert brings
it back. `MutationSucceeded` writes
the server's patches, releases the request's layer and overlays, and records the
result's confirmed `connections` in the position the request's overlays held,
so a temporary edge becomes the real one without a flicker and a page or live
event that later carries the same edge does not duplicate it. `MutationFailed`
releases both, revealing the base. A retried result is a no-op.

## Connections

A connection stores entity references with explicit known boundaries, not a flat
array plus `hasNext`, so an unloaded middle page is a gap rather than an implied
adjacency. Pages, live inserts, and optimistic inserts are all evidence about the
same structure and merge through one pure reducer:

```ts
Remote.update(remote, { _tag: 'ConnectionMerged', connection: 'ProjectsByOwner(...)', page })
```

`items`, `hasNext`, `hasPrevious`, and `isGapped` read the server-known region;
`Remote.visibleItems(model, connection)` is what a view shows: overlays placed
around it, minus edges a live removal or an optimistic remove hid and edges
whose target is a tombstone, so a deleted entity never dangles in a list. A
merged page is newer than the settled overlays it covers: it drops a live
insert it carries and a live removal it contradicts, and leaves a pending
request's overlays alone. A replayed live event is a duplicate by cursor and
changes nothing. `ConnectionInvalidated` marks a connection stale while it keeps
showing its items, and `ConnectionRefreshed` clears it once a fresh page is
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

## Persistence and hydration

A snapshot is the entity store and nothing else: connections' live cursors,
optimistic layers, the mutation ledger, gaps, and retention roots belong to the
session and never appear in one.

```ts
// SSR: the server prefetches, dehydrates for the page, the client hydrates.
const html = dehydrate(serverStore, { scope: userId })
Data.update(model.remote, {
  _tag: 'Hydrated',
  entities: hydrate(html, { scope: userId }) ?? emptyStore,
  merge: 'preserve-existing',
})

// A browser cache, through Effect's KeyValueStore:
RemotePersistence.save(store, { key: 'remote-cache', scope: userId, maxBytes: 512_000 })
RemotePersistence.restore({ key: 'remote-cache', scope: userId, maxBytes: 512_000 })
```

`dehydrate` and `hydrate` are the string forms; `save` and `restore` put them
behind `KeyValueStore`, so the backend (memory, filesystem, Web Storage, SQL) is
the application's choice. The text is deterministic (equal stores give
byte-equal snapshots), a `scope` (a user, a tenant, a build) keeps one reader's
cache from another, and `maxBytes` bounds what is written and read. The cache is
server-derived and disposable: a snapshot that is oversized, another version,
another scope, or malformed is discarded (and its key removed) and the planner
refetches. `Hydrated` is a Message like every other cache change; `replace`
takes the snapshot's entries and `preserve-existing` keeps entries the store
already holds, which are at least as fresh. Hydrating the same snapshot twice is
the same as once.

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
- **Disposable cache persistence.** Deterministic, scoped, size-bounded
  snapshots of the entity store: `dehydrate`/`hydrate` as text, `save`/`restore`
  over `KeyValueStore`, and `Hydrated` to merge one into the Model.

## Limits

- The transport is not part of the package. Effect RPC is the wire; the
  application supplies the client and server protocol layers. `ReadBatch` and
  `LiveRequirement` name `REMOTE_PROTOCOL_VERSION`; a server refuses another
  version with `RemoteProtocolError`, so a wire change is a version bump, never
  silent drift.
- The wire `LiveChange` union carries entity patches, deletes, and connection
  insert/remove/invalidate changes; the client adapter reconstructs a `LiveEvent`
  from it. `RemoteServer.live` serves them as a stream.
- Coalescing is per `RemoteClient` layer: two Remote domains with separate
  layers do not share a batch. `Remote.retain` collects only what the
  application lists; a Surface it does not list loses its data on the next
  `RetentionChanged`.
- `RemoteData` is a closed union.
