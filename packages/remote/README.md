# foldkit-remote

Normalized application-facing server state for Foldkit. Entities, field
selections, queries, connections, mutations, and live patches reconcile into one
normalized store that is part of the Model — there is no hidden mutable cache.

The pure core (store, planner, connections, live classification, optimistic
layers) performs no I/O. `Remote.*` helpers that read or write go through the
`RemoteClient` Effect service, which the application wires to Effect RPC or any
transport.

## Define entities, selections, and operations

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

Relations are reference codecs, so a recursive relation needs no inline target
schema. `Selection.make` infers the picked Struct; an unknown field is a compile
error.

## Declare the domain and embed its submodel

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

`Data.update` is the one reducer for every producer: a read batch, a mutation
result, a live event, a connection merge, or an optimistic layer.

## Read in a Surface

```ts
const ProjectPage = Surface.define(App, 'ProjectPage', {
  Params: Schema.Struct({ projectId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({
      project: Remote.select(AppRemote, ProjectSummary)(params.projectId),
    }),
  messages: [Message.Ping],
})
```

The projection reads `RemoteData<ProjectSummary>` purely: `Initial` until the
selected fields are present, `Failed` if the server data does not decode,
`NotFound` for a tombstone, `Ready`/`Refreshing` otherwise. `Remote.select` is
constrained to the domain's registered entity names, so selecting an entity
`Data` never declared is a compile error.

## Observe and mutate

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
break both arrive as `RemoteMessage`s, so one handler covers success and failure.

```ts
// In update, issued as a Command:
Remote.mutateInto(AppRemote, model, RenameProject, { id, name }, requestId)
// => Effect<{ output: { id: string }; model: Model }, RemoteMutationError, RemoteClient>
```

`Remote.mutate` returns the decoded `output` **and** the result's normalized
`entities`, so a caller that manages its own Messages can reduce them with
`Remote.update`. `Remote.mutateInto` does the `MutationStarted` →
request → `MutationSucceeded` round trip and returns the new Model.

## Optimistic layers

```ts
Data.update(model.remote, {
  _tag: 'OptimisticAdded',
  layer: { id: requestId, patches: [{ entity: 'Project', id, values: { name } }] },
})
```

Settling is remove-the-layer, so overlapping optimistic changes rebase instead of
needing inverse patches. `MutationSucceeded`/`MutationFailed` remove the layer and
`MutationSucceeded` writes the server's patches at most once per `requestId`.

## Persistence

```ts
RemotePersistence.save(store, { key: 'remote-cache' })
RemotePersistence.restore({ key: 'remote-cache' })
```

Both require Effect's `KeyValueStore`. The cache is server-derived and
disposable: a version mismatch or malformed snapshot is discarded and refetched.

## The server

```ts
const Server = RemoteServer.make({
  entities: [
    RemoteServer.entity(Project, {
      authorize: (principal, fields) => fields.filter(field => principal.canRead(Project, field)),
      read: ({ ids, fields, principal }) => loadProjects(ids, fields, principal),
    }),
  ],
  mutations: [
    RemoteServer.mutation(RenameProject, ({ input, principal }) =>
      renameProject(input, principal).pipe(Effect.map(output => ({ output, entities: [...] }))),
    ),
  ],
  queries: [
    RemoteServer.query(ProjectsByOwner, ({ input, window }) => projectsPage(input, window)),
  ],
  live: [
    RemoteServer.live(Project, { subscribe: ({ after }) => projectEvents(after) }),
  ],
})

const handlers = RemoteServer.handlers(Server, principal)
// FoldkitRemoteRead, FoldkitRemoteMutate, FoldkitRemoteQuery, FoldkitRemoteLive
```

Selection authorization is mandatory and separate from authentication: an empty
field list means the principal sees nothing. Sources keep runtime dependencies in
the Effect environment instead of capturing a database.

The wire is Effect RPC (`RemoteRpc`); choose the transport with Effect's own
client and server protocol layers.
