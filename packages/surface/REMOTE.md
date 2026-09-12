
# Foldkit Remote

## Revised architecture using Foldkit Surface + Effect v4 infrastructure

**Status:** Design plan
**Target:** Foldkit 0.158+ / Effect v4
**Repository:** `doeixd/foldkit-plus`

---

# 1. Thesis

`foldkit-remote` should not be a networking framework, persistence framework, RPC framework, or database framework.

Effect already provides those layers.

`foldkit-remote` should provide the things neither Foldkit nor Effect currently provide:

* normalized application-facing server state,
* typed entities and entity references,
* typed field selections,
* typed queries and connections,
* typed mutations,
* field-presence tracking,
* declarative remote requirements,
* cache/request planning,
* cache reconciliation,
* optimistic entity layers,
* Surface Projection integration,
* Foldkit Submodel integration.

Everything below that should be delegated to Effect.

The architecture becomes:

```text
                       Foldkit
             Model · Message · update · Command
                          │
                          ▼
                  foldkit-surface
                     Projection
                          │
                          ▼
                  foldkit-remote
        normalized entities / selections /
         queries / planning / reconciliation
                          │
                          ▼
                      Effect v4
         ┌────────────────┼─────────────────┐
         │                │                 │
        RPC          Persistence        Durability
         │                │                 │
  HTTP / WS /       KV / SQL /       Queue / EventLog /
 Worker / custom     IndexedDB          Workflow
```

Remote owns semantic data modeling.

Effect owns infrastructure.

---

# 2. Initial package set

Start with only:

```text
foldkit-surface

foldkit-remote
foldkit-remote-server
```

Potentially later:

```text
foldkit-remote-drizzle
```

only if it proves significant value.

Do **not** initially create:

```text
foldkit-remote-http
foldkit-remote-websocket
foldkit-remote-indexeddb
foldkit-remote-sql
foldkit-remote-durable
foldkit-remote-worker
```

Effect already provides most of those infrastructure seams.

---

# 3. Dependency graph

```text
                   foldkit-surface
                          ▲
                          │
                   foldkit-remote
                          ▲
                          │
                foldkit-remote-server
                          ▲
                          │
             optional semantic adapters
                          │
                  remote-drizzle


Effect infrastructure sits below:

effect/unstable/rpc
effect/unstable/persistence
effect/unstable/sql
effect/unstable/eventlog
effect/unstable/workflow
```

Neither `surface` nor `remote` should know whether the final transport is:

```text
HTTP
WebSocket
Worker
Socket
in-process
custom RPC protocol
```

---

# 4. Core API philosophy

Remote API values should be:

* immutable,
* descriptive,
* Schema-backed,
* compositional,
* runtime-introspectable,
* transport independent.

Avoid smart fluent objects.

Prefer:

```ts
pipe(
  Project.ref(projectId),
  Remote.select(AppRemote, ProjectSummary),
)
```

over:

```ts
AppRemote
  .entity(Project, projectId)
  .select(ProjectSummary)
  .live()
  .freshFor(...)
```

Domain values describe intent.

Module functions interpret them.

---

# 5. Effect-style API rules

Every meaningful transformation should support:

```ts
fn(value, arg)
```

and where useful:

```ts
pipe(
  value,
  fn(arg),
)
```

using Effect-style `dual`.

Example:

```ts
Selection.union(
  ProjectSummary,
  ProjectPermissions,
)
```

and:

```ts
pipe(
  ProjectSummary,
  Selection.union(ProjectPermissions),
)
```

Likewise:

```ts
Remote.select(
  ref,
  AppRemote,
  selection,
)
```

and:

```ts
pipe(
  ref,
  Remote.select(
    AppRemote,
    selection,
  ),
)
```

Direct calls remain preferred where piping makes the code less obvious.

Pipeability is a compositional affordance, not a style requirement.

---

# 6. Entities

Entities describe normalized server objects.

```ts
const User = Entity.make("User", {
  id: UserId,

  fields: {
    name: Schema.String,
    avatarUrl: Schema.String,
  },
})

const Project = Entity.make("Project", {
  id: ProjectId,

  fields: {
    name: Schema.String,
    status: ProjectStatus,

    owner: Entity.ref(User),
  },
})
```

`Entity.make` produces an immutable descriptor.

The stable name:

```text
"Project"
```

is a protocol/cache identity.

It is intentionally persistent.

---

# 7. Entity references

```ts
const project =
  Project.ref(projectId)
```

produces:

```text
EntityRef<Project>
```

Conceptually:

```ts
{
  entity: Project,
  id: projectId,
}
```

It contains no cache and no transport.

The same value can be interpreted by:

```text
Remote
RemoteServer
DevTools
invalidation
optimistic patches
tests
```

This should fail:

```ts
Project.ref(userId)
```

when branded IDs differ.

---

# 8. Selections

Selections describe required fields.

```ts
const UserSummary = Selection.make(User, {
  id: true,
  name: true,
  avatarUrl: true,
})
```

Nested relations compose:

```ts
const ProjectSummary = Selection.make(Project, {
  id: true,
  name: true,
  status: true,
  owner: UserSummary,
})
```

The inferred value type is:

```ts
{
  id: ProjectId
  name: string
  status: ProjectStatus

  owner: {
    id: UserId
    name: string
    avatarUrl: string
  }
}
```

No parallel interface.

No explicit generic.

---

# 9. Selection composition

Selections are first-class values.

```ts
const DetailedProject = pipe(
  ProjectSummary,
  Selection.union(ProjectPermissions),
  Selection.union(ProjectDates),
)
```

The union operation merges compatible field selections.

Conflicting relation/entity selections should fail statically where possible and defensively at runtime.

---

# 10. Remote definition

A Remote domain groups the descriptors needed for runtime decoding and protocol registration.

```ts
const Data = Remote.make({
  entities: [
    User,
    Project,
  ],

  queries: [
    ProjectsByOwner,
  ],

  mutations: [
    RenameProject,
  ],
})
```

This produces:

```ts
Data.Model
Data.Message
Data.update
Data.initial
Data.rpc
```

Potentially:

```ts
Data.registry
```

for runtime lookup.

---

# 11. Avoid giant type unions

`Remote.make` should not turn every operation into a gigantic application-wide conditional type if that hurts compiler performance or inference.

Prefer:

```text
runtime registry
+
small nominal/scope brand
+
local generic relationships
```

over:

```text
every operation carries every registered entity/query/mutation in its type
```

The type system should primarily prove local relationships:

```text
this Selection belongs to this Entity

this ID belongs to this Entity

this Query takes this Input

this Mutation produces this Output
```

Application-scope isolation is secondary.

Good inference matters more than maximal nominal cleverness.

---

# 12. Remote Model

`Data.Model` is an ordinary Foldkit Submodel state.

Conceptually:

```ts
interface RemoteModel {
  entities: EntityStore
  queries: QueryStore
  requests: RequestState
  mutations: MutationState
  optimistic: OptimisticLayers
}
```

The application embeds it:

```ts
const Model = Schema.Struct({
  route: Route,
  session: Session,

  remote: Data.Model,
})
```

The normalized cache therefore remains:

> part of the Foldkit Model.

There is no hidden mutable cache beside Foldkit.

---

# 13. Binding Remote to Surface

After creating the application Surface scope:

```ts
const App = Surface.make({
  Model,
  Message,
})
```

bind the Remote domain to its Model location:

```ts
const AppRemote = pipe(
  Data,
  Remote.at(App.model.remote),
)
```

Equivalent data-first form:

```ts
const AppRemote =
  Remote.at(
    Data,
    App.model.remote,
  )
```

`AppRemote` is an immutable descriptor.

It means:

```text
Remote domain Data lives at
App.model.remote
```

---

# 14. Remote Projection

A Remote selection becomes a Surface Projection.

```ts
const project = pipe(
  Project.ref(projectId),

  Remote.select(
    AppRemote,
    ProjectSummary,
  ),
)
```

Its value is:

```ts
RemoteData<
  typeof ProjectSummary.Type
>
```

It also carries dependency metadata:

```text
Project:p123
├ id
├ name
├ status
└ owner
   ├ id
   ├ name
   └ avatarUrl
```

---

# 15. Surface integration

```ts
const ProjectPage = Surface.define(
  App,
  "ProjectPage",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        route: model.route,

        project: pipe(
          Project.ref(params.projectId),

          Remote.select(
            AppRemote,
            ProjectSummary,
          ),
        ),
      }),

    messages: [
      Message.ClickedArchiveProject,
    ],
  },
)
```

This Surface now describes:

```text
LOCAL

route


REMOTE

Project:p123
├ id
├ name
├ status
└ owner → User
           ├ id
           ├ name
           └ avatarUrl


MESSAGES

ClickedArchiveProject
```

One contract.

---

# 16. RemoteData

Use a Schema-backed tagged union.

Recommended states:

```text
Initial
Loading
Ready
Refreshing
Failed
NotFound
```

Potential definition:

```ts
type RemoteData<A> =
  | Initial
  | Loading
  | Ready<A>
  | Refreshing<A>
  | Failed<A>
  | NotFound
```

`Refreshing` and `Failed` may retain the previous value.

Example:

```ts
pipe(
  model.project,

  RemoteData.match({
    Initial: () => ...,

    Loading: () => ...,

    Ready: ({ value }) =>
      renderProject(value),

    Refreshing: ({ value }) =>
      renderProject(value),

    Failed: ({ error, previous }) =>
      renderFailure(error, previous),

    NotFound: () =>
      renderNotFound(),
  }),
)
```

No Suspense-like hidden control flow.

---

# 17. Normalized entity store

Internally:

```text
Project:p1

id       PRESENT
name     PRESENT
status   MISSING
owner    PRESENT → User:u7


User:u7

id          PRESENT
name        PRESENT
avatarUrl   STALE
```

Presence metadata must be separate from values.

The cache must distinguish:

```text
missing
present undefined
present null
stale
not found
```

---

# 18. Tombstones

Entity absence is cacheable.

```text
Project:p404 → NOT_FOUND
```

Without tombstones, a missing entity would be fetched indefinitely.

Tombstones can be cleared by:

```text
invalidation
live creation
cache reset
explicit mutation result
```

---

# 19. Requirements

Remote Projection metadata produces a pure requirement tree.

Example:

```text
EntityRequirement

Project:p123
├ name
├ status
└ owner
   └ User
      ├ name
      └ avatarUrl
```

Requirements are plain immutable data.

They can be:

```text
combined
inspected
serialized
diffed against cache
shown in DevTools
```

---

# 20. Planning

The most important pure function in the package is:

```ts
Remote.plan(
  cache,
  requirements,
)
```

or pipeable:

```ts
pipe(
  requirements,
  Remote.plan(cache),
)
```

It returns:

```text
RequestPlan
```

Example:

```text
REQUIRED

Project:p1
├ name
├ status
└ owner
   └ avatarUrl


CACHE

Project:p1.name       ✓
Project:p1.status     ✗
Project:p1.owner      ✓ → User:u7

User:u7.avatarUrl     ✗


PLAN

Project:p1
└ status

User:u7
└ avatarUrl
```

No Effect.

No transport.

No Clock.

No mutable state.

---

# 21. Planning should be deterministic

Given:

```text
RemoteModel
Requirements
FreshnessPolicy
CurrentTime
```

planning must return the same result.

If time matters:

```ts
Remote.plan(
  model,
  requirements,
  {
    now,
  },
)
```

rather than calling:

```ts
Date.now()
```

inside the planner.

Effect `Clock` can supply `now` outside the pure planner.

---

# 22. Effect RPC is the wire layer

Do not create:

```text
RemoteTransport
```

Effect already has an RPC abstraction and transport protocol services.

Effect's RPC package includes typed RPC definitions/groups, clients, servers, middleware, serialization and transport protocol layers.

Server protocol Layers already exist for HTTP, WebSockets, sockets, workers and custom protocols.

Remote should generate or expose an Effect RPC group.

Conceptually:

```ts
const Read = Rpc.make("FoldkitRemoteRead", {
  payload: ReadBatch,
  success: ReadBatchResult,
  error: RemoteReadError,
})

const Mutate = Rpc.make("FoldkitRemoteMutate", {
  payload: MutationRequest,
  success: MutationResult,
  error: RemoteMutationError,
})

const Live = Rpc.make("FoldkitRemoteLive", {
  payload: LiveRequirement,
  success: RpcSchema.Stream(LivePatch),
  error: RemoteLiveError,
})
```

Then:

```ts
const RemoteRpc = RpcGroup.make(
  Read,
  Mutate,
  Live,
)
```

Exact Effect v4 API syntax should be verified against the pinned RC during implementation.

The architectural point is:

> Remote defines RPC semantics, not transport.

---

# 23. Read batching

Remote itself creates a `ReadBatch`.

For example:

```text
Project:p1 { status }

User:u7 { avatarUrl }

Project:p2 { name }
```

becomes one RPC payload.

Effect RPC transports the batch.

This keeps batching semantic rather than dependent on whether a particular transport implementation automatically batches RPC calls.

---

# 24. Reads versus mutations

Reads:

```text
may dedupe
may union
may batch
```

Mutations:

```text
must preserve semantic order
must not automatically merge
must not automatically batch
```

A future explicit transaction abstraction can batch mutations if needed.

Never infer that ordinary mutations commute.

---

# 25. Observation

Reading a Surface must remain pure.

This:

```ts
Surface.read(...)
```

does not fetch.

The application uses a Foldkit Subscription or Remote-provided Subscription descriptor:

```ts
Remote.observe(
  AppRemote,
  ProjectPage,
  {
    projectId,
  },
)
```

Conceptually:

```text
Surface requirements
       │
       ▼
Remote.plan
       │
       ▼
RequestPlan
       │
       ▼
RPC Effect
       │
       ▼
Remote.Message
       │
       ▼
Remote.update
```

I/O stays outside view/rendering.

---

# 26. Request execution

Remote should separate:

```text
plan
```

from:

```text
execute
```

Example:

```ts
const plan =
  Remote.plan(
    remoteModel,
    requirements,
  )
```

Then:

```ts
Remote.execute(plan)
```

returns an Effect using the generated RPC client.

Conceptually:

```ts
Effect<
  ReadBatchResult,
  RemoteReadError,
  RemoteRpcClient
>
```

Transport requirements remain downstream inside the Layer graph.

---

# 27. RPC Layers

Applications choose transport directly from Effect.

Conceptually:

```ts
const RemoteClientLive =
  Data.rpc.clientLayer.pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: "/api/remote",
      }),
    ),
  )
```

or WebSocket:

```ts
Layer.provide(
  RpcClient.layerProtocolSocket(),
)
```

Exact APIs depend on the Effect version.

Remote does not wrap them merely to rename them.

---

# 28. Testing transport

Use Effect RPC's test/in-process tooling where possible.

Effect already exports:

```text
RpcTest
```

and decoded protocol/server primitives.

If a Remote-specific in-memory helper provides real ergonomic value, it should itself be a tiny Layer over Effect RPC, not a parallel transport stack.

---

# 29. Queries

Queries describe server-side list/search/aggregate operations.

```ts
const ProjectsByOwner = Query.make(
  "ProjectsByOwner",
  {
    Input: Schema.Struct({
      ownerId: UserId,
    }),

    Result:
      Query.connection(Project),
  },
)
```

Reference:

```ts
const query = ProjectsByOwner.ref({
  ownerId,
})
```

Pagination:

```ts
const page = pipe(
  query,
  Query.first(20),
)
```

Projection:

```ts
const projects = pipe(
  page,

  Remote.select(
    AppRemote,
    ProjectSummary,
  ),
)
```

No string cache keys.

---

# 30. Query identity

A QueryRef contains:

```text
Query descriptor
canonical encoded input
pagination/window
```

The cache key is derived from those values.

Application developers do not write:

```ts
["projects", ownerId]
```

The Schema-encoded Query input is the identity source.

---

# 31. Connections

Connection state stores entity references, not entity copies.

```text
ProjectsByOwner(u7)

Project:p1
Project:p3
Project:p2

endCursor
hasNextPage
```

The entity store remains:

```text
Project:p1
Project:p2
Project:p3
```

Updating:

```text
Project:p3.name
```

updates every connection that contains it automatically.

---

# 32. Mutations

Mutations are typed remote descriptions.

```ts
const RenameProject = Mutation.make(
  "RenameProject",
  {
    Input: Schema.Struct({
      id: ProjectId,
      name: Schema.String,
    }),

    Output: Schema.Struct({
      projectId: ProjectId,
    }),
  },
)
```

Calling:

```ts
Remote.mutate(
  RenameProject,
  {
    id: projectId,
    name,
  },
)
```

returns an Effect whose output is inferred from the Mutation descriptor.

No explicit generics.

---

# 33. Mutations remain below Foldkit Messages

The UI still produces:

```text
ClickedRenameProject
```

`update` interprets that fact and creates the Remote mutation Command/effect.

```text
UI
 │
 ▼
Message
 │
 ▼
update
 │
 ▼
Command
 │
 ▼
Remote.mutate
 │
 ▼
Effect RPC
```

Remote does not become an alternate action system.

---

# 34. Mutation response

A Mutation RPC result should include:

```text
typed Output

plus

normalized cache operations
```

Example:

```ts
{
  output: {
    projectId,
  },

  entities: [
    Project.patch(projectId, {
      name,
    }),
  ],
}
```

The client applies the cache patches through:

```text
Remote.Message
→ Remote.update
```

---

# 35. Optimistic updates

Optimistic state stays inside Remote.Model.

Use layers:

```text
base cache

+
optimistic patch #1

+
optimistic patch #2

=

visible cache
```

Success:

```text
merge server patch
remove optimistic layer
```

Failure:

```text
remove optimistic layer
```

No inverse-patch calculation.

---

# 36. Optimistic API

Prefer data descriptors:

```ts
const optimistic = Entity.patch(
  Project.ref(projectId),
  {
    name,
  },
)
```

Then:

```ts
Remote.mutate(
  RenameProject,
  input,
  {
    optimistic: [
      optimistic,
    ],
  },
)
```

The patch is checked against the Entity Schema.

---

# 37. Live data

Use streaming Effect RPC.

Remote does not need a separate WebSocket/SSE subsystem.

The RPC group exposes a streaming method.

The chosen Effect RPC transport decides whether the stream travels over:

```text
WebSocket
HTTP streaming
worker channel
socket
custom protocol
```

Remote receives normalized live patches and feeds them through:

```text
Remote.Message
→ Remote.update
```

into the same normalized cache.

---

# 38. Server package

`foldkit-remote-server` provides the Foldkit/Remote-specific server semantics that Effect RPC does not know.

It owns:

```text
EntitySource
QuerySource
MutationSource
selection authorization
normalization
cache-result construction
Source registry
```

It does **not** own:

```text
HTTP
WebSocket
serialization
authentication protocol
database connections
```

---

# 39. Entity Source

```ts
const ProjectSource =
  RemoteServer.entity(
    Project,
    ({ ids, selection }) =>
      Effect.gen(function* () {
        const db = yield* Database

        return yield* loadProjects(
          db,
          ids,
          selection,
        )
      }),
  )
```

Dependencies stay in the Effect environment.

Do not write:

```ts
RemoteServer.entity(Project, {
  db,
})
```

Configuration descriptors and runtime resources remain separate.

---

# 40. Query Source

```ts
const ProjectsByOwnerSource =
  RemoteServer.query(
    ProjectsByOwner,

    ({ input, selection, page }) =>
      Effect.gen(function* () {
        const db = yield* Database

        ...
      }),
  )
```

Its Result is inferred from the Query descriptor.

---

# 41. Mutation Source

```ts
const RenameProjectSource =
  RemoteServer.mutation(
    RenameProject,

    ({ input }) =>
      Effect.gen(function* () {
        const db = yield* Database

        yield* renameProject(
          db,
          input,
        )

        return RemoteServer.result({
          output: {
            projectId: input.id,
          },

          entities: [
            Entity.patch(
              Project.ref(input.id),
              {
                name: input.name,
              },
            ),
          ],
        })
      }),
  )
```

The server implementation returns semantic cache patches.

Transport serialization is handled by Effect RPC.

---

# 42. Server construction

```ts
const Server = RemoteServer.make(
  Data,
  {
    entities: [
      UserSource,
      ProjectSource,
    ],

    queries: [
      ProjectsByOwnerSource,
    ],

    mutations: [
      RenameProjectSource,
    ],
  },
)
```

This produces handlers for `Data.rpc`.

Conceptually:

```ts
const RpcHandlers =
  RemoteServer.handlers(Server)
```

which can be provided to Effect RPC.

---

# 43. Authentication

Remote should not define its own HTTP authentication callback.

Use Effect RPC middleware / Effect services.

For example:

```ts
Effect.gen(function* () {
  const principal = yield* Principal
  ...
})
```

Authentication middleware provides:

```text
Principal
```

into the handler environment.

Remote Sources consume it like any other service.

This prevents identity from leaking into client-controlled Remote input.

---

# 44. Authorization

Remote Server still needs semantic authorization because it understands fields/entities.

Example:

```ts
RemoteServer.entity(Project, {
  authorize: ({ principal, id }) =>
    ...,

  fields: {
    privateNotes: {
      authorize: ({ principal, entity }) =>
        ...
    },
  },

  read: ...
})
```

Authentication answers:

> Who is this?

Remote authorization answers:

> May this principal read this semantic field/entity?

Do not conflate them.

---

# 45. Persistence

Do not create a Remote-specific persistence backend abstraction.

Effect already has:

```text
KeyValueStore
Persistence
PersistedCache
PersistedQueue
```

The KV service supports memory, filesystem, Web Storage and SQL, and browser packages provide IndexedDB Layers.

Remote only needs snapshot encoding/decoding helpers.

---

# 46. Persisting Remote.Model

Provide something like:

```ts
RemotePersistence.save(
  Data,
  remoteModel,
  {
    key: "remote-cache",
  },
)
```

which requires:

```text
KeyValueStore
```

in the Effect environment.

Restore:

```ts
RemotePersistence.restore(
  Data,
  {
    key: "remote-cache",
  },
)
```

Possible package/module location:

```text
foldkit-remote/RemotePersistence
```

not a separate npm package.

---

# 47. Persistence layer choice

Application:

```ts
Effect.provide(
  persistenceProgram,

  BrowserKeyValueStore.layerIndexedDb({
    database: "my-app",
  }),
)
```

or:

```ts
Effect.provide(
  persistenceProgram,

  KeyValueStore.layerSql(),
)
```

or:

```ts
KeyValueStore.layerMemory
```

Remote does not care.

---

# 48. Remote cache persistence is disposable

Remote persistence differs from Sync.

Remote data is derived from a server.

Therefore an incompatible persisted Remote cache can usually:

```text
fail decode
→ clear
→ refetch
```

That should be the default recovery policy.

Do not copy Sync's stricter preservation policy.

Sync may contain unsent user edits.

Remote should not.

---

# 49. PersistedCache

Effect's `PersistedCache` may be useful for specific request-level caching or server-source caching.

It should **not** replace Remote's normalized cache.

These solve different problems:

```text
PersistedCache

Request → Result
```

versus:

```text
Remote.Model

Entity + Field → Value
```

Remote may optionally use or document `PersistedCache` for expensive server reads.

It should not wrap it as a new Remote abstraction unless real use cases demand it.

---

# 50. Durable work

Do not build Remote-specific durable queues.

Effect already has `PersistedQueue`, including retries, deduplication, SQL/Redis/memory storage and at-least-once processing.

A Remote Mutation Source can simply require:

```text
PersistedQueueFactory
```

and enqueue work.

Likewise, long-running durable workflows can use Effect's workflow APIs.

---

# 51. `foldkit-durable`

`foldkit-durable` remains valuable where it provides Foldkit-specific semantics:

```text
ordered Message log
authoritative replay
snapshot + cursor
Message idempotency
Foldkit effect ledger
```

But its implementation should be reviewed against Effect's newer:

```text
EventJournal
EventLog
PersistedQueue
Workflow
Persistence
```

The goal should be:

> preserve Foldkit-specific semantics, reuse Effect durability infrastructure wherever practical.

Remote should integrate with `foldkit-durable` only through ordinary Source dependencies.

No `foldkit-remote-durable` package initially.

---

# 52. Drizzle adapter

Only add:

```text
foldkit-remote-drizzle
```

if it can do substantial semantic work.

The bar should be:

```text
Selection
    ↓
derive selected columns

Entity relations
    ↓
derive relation loading

Query pagination
    ↓
derive query shape

rows
    ↓
normalized Remote patches
```

If the adapter only saves:

```text
10 lines of Source code
```

it does not deserve a package.

---

# 53. Potential Drizzle API

```ts
const ProjectSource =
  RemoteDrizzle.entity(
    Project,
    {
      table: projects,

      id: projects.id,

      fields: {
        name: projects.name,
        status: projects.status,

        owner:
          RemoteDrizzle.ref(
            User,
            projects.ownerId,
          ),
      },
    },
  )
```

The resulting Source still depends on the database through Effect.

It does not capture a database instance.

---

# 54. Surface-driven observation

Remote should be able to derive all remote requirements from an existing Surface.

```ts
Remote.observe(
  AppRemote,
  ProjectPage,
  params,
)
```

It should not require:

```ts
Remote.observe(
  AppRemote,
  Project.ref(...),
  ProjectSummary,
)
```

when the Surface already states that information.

This is one of the core integration benefits.

---

# 55. Projection-driven observation

For lower-level use:

```ts
Remote.observeProjection(
  AppRemote,
  projection,
)
```

should also exist.

Surface is convenience/composition.

Projection is the actual dependency description.

---

# 56. Prefetching

Same mechanism:

```ts
Remote.prefetch(
  AppRemote,
  ProjectPage,
  params,
)
```

or:

```ts
pipe(
  projection,
  Remote.prefetch(AppRemote),
)
```

The operation:

```text
extract requirements
→ plan
→ execute missing reads
→ return Remote messages/result
```

can be used for:

```text
SSR
route prefetch
hover prefetch
agent preparation
tests
```

---

# 57. SSR

Because transport is Effect RPC:

```text
browser
→ HTTP/WebSocket RPC Layer
```

and:

```text
SSR server
→ in-process RPC Layer
```

can run the same Remote code.

There should be no server-specific Remote read API.

Provide the same RPC client against a local protocol/handler Layer.

Then:

```text
prefetch Surface
→ Remote Model populated
→ render
→ serialize Model
→ hydrate
```

---

# 58. DevTools

Remote should provide pure introspection functions:

```ts
Remote.inspect(remoteModel)

Remote.inspectEntity(
  remoteModel,
  Project.ref(projectId),
)

Remote.inspectQuery(
  remoteModel,
  queryRef,
)

Remote.plan(
  remoteModel,
  requirements,
)
```

DevTools should not depend on private Map layouts.

---

# 59. Surface DevTools

Combined display:

```text
ProjectPage

LOCAL
route.projectId

REMOTE
Project:p123
├ id          ready
├ name        ready
├ status      loading
└ owner       ready → User:u7
   ├ name     ready
   └ avatar   stale

MESSAGES
ClickedArchiveProject

REQUEST PLAN
User:u7.avatar
```

That becomes possible because Surface and Remote share Projection metadata.

---

# 60. Agent integration

No dedicated Agent adapter initially.

`foldkit-agent` consumes Surface/Projection.

Therefore Remote-backed context works automatically at the type/model level.

Initially the agent sees:

```text
RemoteData
```

as part of its context.

If later Agent gains effectful resource resolution, it can call:

```ts
Remote.prefetch(...)
```

before reading.

Do not couple Remote to Agent prematurely.

---

# 61. Sync integration

Remote and Sync remain siblings.

Never make Remote the storage layer for Sync.

Never make Sync the persistence layer for Remote.

Use Remote for:

```text
server-derived disposable state
```

Use Sync for:

```text
client-owned replicated state
offline writes
convergence
```

A Surface may combine both.

---

# 62. One owner per datum

This should become an explicit repository rule:

> A logical piece of state should have one authoritative owner.

Bad:

```text
Project.title

stored in Sync
and
stored separately in Remote
```

Good:

```text
Project collaborative draft
→ Sync

Project analytics summary
→ Remote

currently selected project
→ local Model
```

Surface composes them.

It does not erase ownership boundaries.

---

# 63. Core errors

Remote's semantic errors should be Schema-backed tagged errors:

```text
RemoteSelectionError
RemoteDecodeError
RemoteProtocolError
RemoteNotFoundError
RemoteUnauthorizedError
RemoteMutationError
RemoteVersionError
```

Transport failures should generally remain Effect RPC/client protocol errors where possible.

Do not wrap every Effect error merely to rename it.

Only introduce a Remote error when Remote adds semantic meaning.

---

# 64. Metrics and tracing

Use Effect tracing.

Suggested spans:

```text
FoldkitRemote.plan
FoldkitRemote.read
FoldkitRemote.mutate
FoldkitRemote.live
FoldkitRemote.prefetch
```

Metadata:

```text
entity/query/mutation name
field count
cache hit count
cache miss count
batch size
```

Never attach sensitive values.

---

# 65. Implementation phases

## Phase 1 — Surface prerequisite

Finish:

```text
ModelRef
Projection
Surface
```

with strong inference.

Remote should not build its own projection abstraction.

---

## Phase 2 — Pure Remote core

Implement:

```text
Entity
EntityRef
Selection
RemoteData
normalized EntityStore
field presence
tombstones
Requirement
Remote.plan
Remote.merge
```

No network.

No Effect RPC.

No database.

This proves the core semantics.

---

## Phase 3 — Surface integration

Implement:

```text
Remote.make
Remote.at
Remote.select
remote Projection nodes
Surface requirement extraction
```

Prove mixed:

```text
local + remote
```

Projections work naturally.

---

## Phase 4 — Queries

Implement:

```text
Query.make
QueryRef
connections
pagination
query cache
connection normalization
```

Still no transport.

---

## Phase 5 — Effect RPC

Create the Remote RPC group:

```text
ReadBatch
Mutate
Live
```

Use:

```text
Effect RPC schemas
Effect RpcGroup
Effect RpcClient
Effect RpcServer
```

No Remote transport interface.

---

## Phase 6 — `foldkit-remote-server`

Implement:

```text
EntitySource
QuerySource
MutationSource
selection authorization
handler compilation
normalization
```

Use Effect services for:

```text
database
principal
logging
cache
durability
```

---

## Phase 7 — Foldkit observation

Implement:

```text
Remote.observe
Remote.observeProjection
Remote.prefetch
```

using Foldkit Subscriptions/Commands and Effect RPC Effects.

---

## Phase 8 — Mutations

Implement:

```text
Mutation.make
Remote.mutate
mutation status
cache patches
typed Output
```

Do not implement optimistic updates until ordinary mutation reconciliation is solid.

---

## Phase 9 — Optimistic layers

Implement:

```text
Entity.patch
optimistic layer
settle success
settle failure
```

Prove overlapping optimistic updates correctly rebase.

---

## Phase 10 — Live streaming

Use Effect streaming RPC.

Merge all live results through the same normalized Remote cache.

No parallel live-state architecture.

---

## Phase 11 — Persistence

Add:

```text
RemotePersistence
```

as a module in `foldkit-remote`.

Require Effect:

```text
KeyValueStore
```

for cache snapshot persistence.

Do not create storage-specific packages.

---

## Phase 12 — SSR

Implement:

```text
Remote.prefetch
in-process Effect RPC
cache serialization
hydration
```

---

## Phase 13 — optional adapters

Only now evaluate:

```text
foldkit-remote-drizzle
```

based on real repeated Source boilerplate.

---

# 66. Public package surface

Recommended `foldkit-remote` exports:

```ts
Entity
EntityRef

Selection

Query
QueryRef
Connection

Mutation

Remote
RemoteData

RemotePersistence

RemoteError
```

Potential internal modules:

```text
Requirement
RequestPlan
EntityStore
QueryStore
Protocol
```

Expose them only where extension use cases justify it.

---

# 67. `foldkit-remote-server` exports

```ts
RemoteServer

EntitySource
QuerySource
MutationSource

ServerResult
Authorization

RemoteServerError
```

Effect RPC integration helpers:

```ts
RemoteServer.handlers(...)
RemoteServer.layer(...)
```

where useful.

Avoid duplicating Effect's RPC Layer APIs.

---

# 68. Example end-to-end API

Entities:

```ts
const User = Entity.make("User", {
  id: UserId,

  fields: {
    name: Schema.String,
    avatarUrl: Schema.String,
  },
})

const Project = Entity.make("Project", {
  id: ProjectId,

  fields: {
    name: Schema.String,
    status: ProjectStatus,
    owner: Entity.ref(User),
  },
})
```

Selections:

```ts
const UserSummary =
  Selection.make(User, {
    id: true,
    name: true,
    avatarUrl: true,
  })

const ProjectSummary =
  Selection.make(Project, {
    id: true,
    name: true,
    status: true,
    owner: UserSummary,
  })
```

Query:

```ts
const ProjectsByOwner =
  Query.make(
    "ProjectsByOwner",
    {
      Input: Schema.Struct({
        ownerId: UserId,
      }),

      Result:
        Query.connection(Project),
    },
  )
```

Mutation:

```ts
const RenameProject =
  Mutation.make(
    "RenameProject",
    {
      Input: Schema.Struct({
        id: ProjectId,
        name: Schema.String,
      }),

      Output: Schema.Struct({
        projectId: ProjectId,
      }),
    },
  )
```

Remote:

```ts
const Data = Remote.make({
  entities: [
    User,
    Project,
  ],

  queries: [
    ProjectsByOwner,
  ],

  mutations: [
    RenameProject,
  ],
})
```

Application:

```ts
const Model = Schema.Struct({
  route: Route,
  remote: Data.Model,
})

const App = Surface.make({
  Model,
  Message,
})

const AppRemote = pipe(
  Data,
  Remote.at(App.model.remote),
)
```

Surface:

```ts
const ProjectPage = Surface.define(
  App,
  "ProjectPage",
  {
    Params: Schema.Struct({
      projectId: ProjectId,
    }),

    model: ({ model, params }) =>
      Projection.struct({
        route: model.route,

        project: pipe(
          Project.ref(params.projectId),

          Remote.select(
            AppRemote,
            ProjectSummary,
          ),
        ),
      }),

    messages: [
      Message.ClickedRenameProject,
    ],
  },
)
```

Server Source:

```ts
const ProjectSource =
  RemoteServer.entity(
    Project,

    ({ ids, selection }) =>
      Effect.gen(function* () {
        const db = yield* Database

        return yield* loadProjects(
          db,
          ids,
          selection,
        )
      }),
  )
```

Mutation Source:

```ts
const RenameProjectSource =
  RemoteServer.mutation(
    RenameProject,

    ({ input }) =>
      Effect.gen(function* () {
        const db = yield* Database

        yield* renameProject(
          db,
          input,
        )

        return RemoteServer.result({
          output: {
            projectId: input.id,
          },

          entities: [
            Entity.patch(
              Project.ref(input.id),
              {
                name: input.name,
              },
            ),
          ],
        })
      }),
  )
```

Server:

```ts
const Server = RemoteServer.make(
  Data,
  {
    entities: [
      UserSource,
      ProjectSource,
    ],

    queries: [
      ProjectsByOwnerSource,
    ],

    mutations: [
      RenameProjectSource,
    ],
  },
)
```

Transport:

```text
Effect RPC Layers
```

not Foldkit Remote.

Persistence:

```text
Effect KeyValueStore Layers
```

not Foldkit Remote.

Durability:

```text
Effect PersistedQueue / Workflow
or
foldkit-durable
```

not Foldkit Remote.

---

# 69. Architectural rule of thumb

Before adding a Remote abstraction, ask:

> Is this behavior specifically about interpreting Foldkit application state as normalized remote data?

If yes:

```text
foldkit-remote
```

If it is about:

```text
transport
serialization
networking
persistence
storage backend
job queues
workflow durability
SQL connection lifecycle
```

use Effect.

If it is about:

```text
Message replay
offline replicated state
convergence
```

use Sync.

If it is about:

```text
agent permissions
authorization
tool naming
completion
```

use Agent.

If it is about:

```text
state ownership and transitions
```

use Foldkit.

If it is about:

```text
observation/capability boundaries
```

use Surface.

---

# 70. Final architecture

```text
                               Foldkit
                   Model · Message · update · Command
                                  │
                                  ▼
                         foldkit-surface
                observation + capability boundaries
                                  │
                                  ▼
                         foldkit-remote
               normalized remote-state semantics
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
               client                           server
                  │                               │
          Remote requirement               Remote Sources
             planner                           │
                  │                            │
                  └──────────┬─────────────────┘
                             ▼
                         Effect RPC
                             │
                 transport / serialization
                             │
          ┌──────────────────┼─────────────────────┐
          ▼                  ▼                     ▼
        HTTP                WS                  Worker
                             │
                             ▼
                         application
                           services
                             │
          ┌──────────────────┼─────────────────────┐
          ▼                  ▼                     ▼
         SQL             Persistence            Durable
                          / KV                 workflows
```

`foldkit-remote` should feel small because Effect does the hard systems work.

Its value is not that it transports data.

Its value is that it gives Foldkit a typed answer to:

> **What server-derived information does this feature require, what do we already know, what is missing, and how should incoming facts change the application's normalized Model?**

That is the layer worth building.
