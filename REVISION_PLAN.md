# Revision Plan — Foldkit Plus reorganization around Surface and Remote

**Status:** authoritative plan. Supersedes `packages/surface/DESIGN_BRAINSTORM.md`,
`packages/surface/BACKBONE.md`, and `packages/surface/REMOTE.md` wherever they
conflict; those remain for provenance and longer argument. This document is the
single source of truth for the revision.

**Goal:** make `foldkit-plus` a coherent stack over Foldkit and Effect instead of
a collection of independently invented extensions, by introducing one shared
structural vocabulary (`ModelRef` / `Projection` / `Surface`) that Agent, Sync,
and Remote interpret.

**Design principle (the whole thing in one line):**

> Whenever Effect already has a lawful structural primitive, Foldkit Plus enriches
> it with Foldkit semantics rather than replacing it.

---

## 0. How to use this document

- Sections 1–3 are the thesis and the verified substrate. Read them first.
- Sections 4–11 are the design, per package. Each states the API, the invariants,
  and the decisions taken across the three source docs.
- Section 12 is the decision log: every place the source docs disagreed, and the
  resolution.
- Sections 13–17 are execution: phases, risks, testing, release, and the immediate
  next step.
- Concrete code in this document is **illustrative target API**, not a
  commitment to syntax; the Phase 0 spike is what proves it.

---

## 1. Thesis

Foldkit already makes state transitions and effects explicit (Model, Message,
`update`, Command, Submodel). It does **not** make two relationships explicit, and
neither does Effect:

1. **Observation** — what part of the Model may this feature read?
2. **Capability** — what subset of Messages may this feature produce?

Today a view receives `(model: Model, h: HtmlBuilder<Message>)` — the entire Model
and the entire Message universe, regardless of what it needs. The typing system
cannot express the intended boundary; only review and convention can.

`foldkit-plus` currently has **three separately invented projections** of the same
idea:

- `foldkit-agent`: `Context<Model, Value> = { schema, select }` and `Agent.pick`.
- `foldkit-sync`: `Projection<Model, Fields> = { schema, get, set }` and `pick`.
- `foldkit-agent` resources: `{ schema, read }`.

That repetition is the signal: **Projection wants to be a shared primitive.** Once
Messages are also referenced through that primitive, the repo has one contract
vocabulary and each package becomes an interpreter of it.

---

## 2. Foundational formulas

```text
ModelRef   = Effect Optic + Schema + Model dependency metadata

Entity     = Schema.Struct + stable entity identity + normalization metadata

Selection  = derived Schema + remote field-requirement metadata

Surface    = Projection + Message constructor references

Remote     = normalized entity store + requirement planner
             + Effect RPC (wire) + Effect persistence (cache snapshots)
```

And the stack:

```text
Effect Optic ──▶ ModelRef ──▶ Projection ──▶ Surface
Effect Schema.Struct ──▶ Entity ──▶ Selection ──▶ Remote Projection
Effect Schema ──▶ Query Input / Mutation Input+Output / RPC / cache / persistence
Effect RPC ──▶ Remote wire execution
Effect Persistence / KeyValueStore ──▶ Remote cache snapshots (disposable)
```

---

## 3. Verified substrate (effect@4.0.0-rc.112 + foldkit 0.158.2)

These were checked against the installed packages, not the upstream docs. They are
the load-bearing assumptions of the whole revision.

### 3.1 Effect Optic exists and composes

`node_modules/effect/dist/Optic.d.ts`:

- `Optic.id<S>()`, then `.key("name")`, `.at("HOME")`, `.tag("Circle")`,
  `.optionalKey("a")`, `.pick([...])`, `.omit([...])`, `.compose(...)`,
  `.forEach(...)`, `.check(Schema.isGreaterThan(0))`, `.refine(...)`,
  `.notUndefined()`.
- Constructors: `makeIso`, `makeLens`, `makePrism`, `fromChecks`.
- Types: `Iso`, `Lens`, `Prism`, `Optional`, `Traversal`.
- `.key` always focuses; `.at` is the optional/keyed focus (absent key succeeds
  with absence). This is the exact semantics `ModelRef.at(key)` needs.

### 3.2 Effect infrastructure exists

Top-level: `Request`, `RequestResolver`, `Rpc`, `RpcGroup`, `RpcClient`,
`RpcServer`, `KeyValueStore`, `Persistence`, `PersistedCache`, `PersistedQueue`,
`EventJournal`, `EventLog`.

Subpath entries: `effect/unstable/{rpc,persistence,sql,eventlog,workflow,socket,
http,httpapi,cluster,ai,cli,devtools,encoding,observability,process,reactivity,
schema,workers}`.

`effect/unstable/rpc` and `effect/unstable/persistence` are the two the Remote
design depends on. They are `unstable` in the pinned rc, so exact syntax must be
re-verified at implementation time.

### 3.3 Foldkit shapes

- `Message.CreatedTodo` is a callable `TaggedStruct` carrying `_tag` (a
  `Schema.tag<'CreatedTodo'>`), so reference-based classification can read the tag
  directly.
- `defineMessageUnion` returns constructors plus `match`, `guards`, `isAnyOf`,
  `subset`, and a `MessageUnion` type — `subset` is directly useful for building a
  Surface's Message schema.
- `foldkit/update`: `Return<Model, Message, R> = { readonly model: Model;
  readonly commands?: Commands<Message, R> }`; also `combine`, `withOutMessage`,
  `Step`, `Refreshable`/`refresh` (the last is AsyncData revalidation, unrelated to
  a sync refresh Message).
- `foldkit/runtime`: `makeApplication(config)` where config has `Model`, `init`,
  `update`, `view`, `subscriptions?`, `container`, `ports?`, `resources?`, etc.;
  `run`/`embed`/`hydrate`. `ApplicationConfig.init` is `() => Update.Return` (or
  takes flags/url in routing variants).
- `foldkit/message`, `foldkit/update`, `foldkit/runtime`, `foldkit/html`,
  `foldkit/subscription`, `foldkit/port` are separate subpath entries.
- The `foldkit-agent*` packages already peer on `foldkit`; `foldkit-durable` and
  `foldkit-sync` peer only on `effect`.

### 3.4 Consequence

The revision does not depend on unreleased Effect features. The risk is inference
and API churn in `unstable/*`, not missing primitives.

---

## 4. Package architecture

### 4.1 Target graph

```text
                    Foldkit
        Model · Message · update · Command
                       │
                       ▼
                 foldkit-surface            ModelRef · Projection · Surface
                       │
       ┌───────────────┼────────────────────┬───────────────────┐
       ▼               ▼                    ▼                   ▼
 foldkit-agent    foldkit-sync       foldkit-remote      (future interpreters)
 policy/audit     replication        normalized cache
       │               │                    │
  adapters         foldkit-durable     foldkit-remote-server
  (webmcp/mcp/     (journal)           (sources/authorization)
   a2a/native)
                       │
                       ▼
                   Effect v4
   RPC · Persistence · KeyValueStore · PersistedQueue · Workflow · SQL
```

### 4.2 Package responsibilities

| Package | Owns | Depends on |
| --- | --- | --- |
| `foldkit-surface` | `ModelRef`, `Projection`, `Surface`, dependency metadata | `effect`, `foldkit` (peer) |
| `foldkit-remote` | `Entity`, `Selection`, `Query`, `Mutation`, `RemoteData`, normalized store, planner, RPC definitions, cache persistence | `foldkit-surface`, `effect` |
| `foldkit-remote-server` | `EntitySource`, `QuerySource`, `MutationSource`, selection authorization, handler compilation | `foldkit-remote`, `effect` |
| `foldkit-agent` | policy: naming, descriptions, availability, authorization, principal, completion, audit, cancellation | `foldkit-surface`, `effect`, `foldkit` (peer) |
| `foldkit-agent-{webmcp,mcp,a2a,native}` | protocol mapping only | `foldkit-agent` only |
| `foldkit-sync` | offline replica, replay, reconciliation, presence; writable Surface interpreter | `foldkit-surface`, `effect` |
| `foldkit-durable` | durable ordering/storage/effect ledger; **stays independent** | `effect` only |

New npm names follow the repo convention: `foldkit-surface`, `foldkit-remote`,
`foldkit-remote-server`.

### 4.3 Naming / upstream decision

The source docs sometimes write `@foldkit/surface` / `foldkit/surface`, suggesting
upstream Foldkit. **Decision:** build these in this repo under the existing
`foldkit-*` convention for now, but keep `foldkit-surface` (and only Surface)
designed so it could be proposed upstream later. Do not block the revision on an
upstream decision. Rationale: the repo already publishes `foldkit-*` packages, and
Surface is useful across Agent, Sync, and Remote immediately.

### 4.4 The one shared application scope

```ts
export const App = Surface.make({ Model, Message })
```

`Surface.make` is purely descriptive (it does not create a Runtime). It produces
`App.Model`, `App.Message`, `App.model` (the typed root `ModelRef`). Everything
else is scoped to it:

```ts
const ProjectPage = Surface.define(App, "ProjectPage", { ... })
const TodoAgent   = Agent.define(App, "TodoAgent", { ... })
const TodoSync    = Sync.define(App, "TodoSync", { ... })
const Data        = Remote.make({ entities: [...], queries: [...], mutations: [...] })
```

This is how the packages share a vocabulary and (as far as TypeScript allows)
prevent mixing `ModelRef`s from one application with Messages from another.

---

## 5. Surface

### 5.1 ModelRef

A typed reference to a location in the Model. It is **a real Effect optic**, not a
bespoke get/set pair.

```ts
interface ModelRef<Root, Value> {
  readonly Schema: Schema.Schema<Value>   // what lives there
  readonly optic: Optic.Optic<Root, Value> // how to focus (internal)
  readonly dependency: Dependency           // what was focused (metadata)
}
```

Public operations:

```ts
App.model.session.user.name     // typed field access, statically derived from Model
ref.at(key)                     // optional/keyed focus; absent => Option
ref.index(i)                    // array index focus
ref.select(projection)          // narrow through a Projection
ModelRef.fromOptic(...)         // low-level extension
```

Rules:

- `App.model.x.y` **constructs a descriptor**; it does not read application state.
- Property access is the dependency declaration. A `Proxy` may implement the ergonomic
  tree, but the expression itself is the declaration.
- **No implicit dependency tracking.** A selector callback executed against a Proxy to
  discover dependencies is rejected.
- Keep `get`/`set` on `ModelRef` internally from day one, because Sync needs a
  writable projection (a checkpoint must be merged back into the Model). UI Surfaces
  stay read-only at the public level; mutation authority is not granted by a ModelRef.

### 5.2 Projection

An observable projection of a root Model, carrying both its value Schema and its
dependency tree.

```ts
interface Projection<Root, Value> {
  readonly Model: Schema.Schema<Value>
  readonly dependencies: DependencyTree
  readonly read: (root: Root) => Value
}
```

A `ModelRef` is itself usable as a Projection (selecting the whole focus).

API (v1 deliberately small):

```ts
Projection.of(Schema)({ field: true, nested: OtherProjection })  // reusable structural selection
Projection.struct({ ref, projection, ... })                       // combine same-root refs/projections
Projection.array(projection)
Projection.option(projection)
Projection.read(projection, model)          // and data-last Projection.read(projection)(model)
```

- `Projection.of(Project)({ doesNotExist: true })` must not compile.
- `Projection.of(Project)({ owner: ProjectSummary })` must not compile when `owner`
  is a `User`.
- Optional focuses stay safe: if a key may be absent, the focus is optional
  (`ModelRef<Model, Option<Project>>`); the API must not add `.getOrThrow()` for
  convenience.
- No general `Projection.map` initially — derived display values belong in the view,
  so a Projection stays "data observed from Model", not a derived-state system.
- A `Projection` is a runtime descriptor usable by TypeScript, runtime, DevTools,
  tests, MCP, documentation, and render invalidation from one declaration.

### 5.3 Surface

```text
Surface = Projection + Message subset + optional Params + identity
```

```ts
interface Surface<RootModel, Model, Message, Params> {
  readonly name: string
  readonly Params: Schema.Schema<Params>
  readonly Model: Schema.Schema<Model>
  readonly Message: Schema.Schema<Message>
  readonly messages: ReadonlyArray<MessageConstructor>
  readonly dependencies: DependencyTree
  readonly projection: (params: Params) => Projection<RootModel, Model>
}
```

Definition:

```ts
const ProjectCard = Surface.define(App, "ProjectCard", {
  Params: Schema.Struct({ projectId: ProjectId }),
  model: ({ model, params }) =>
    Projection.struct({
      project: model.projects.at(params.projectId).select(ProjectSummary),
    }),
  messages: [Message.ChangedProjectName, Message.ClickedArchiveProject],
})
```

- `Params` optional (conceptually `void`); `messages` optional (read-only Surface,
  `Message` = `never`).
- `"ProjectCard"` is a diagnostic identifier for DevTools/docs/duplicate detection;
  renaming it changes no semantics.
- Message inputs are **constructor references**, never tag strings.
- A Surface is an **access boundary**, distinct from a Submodel (an ownership
  boundary): it owns no Model, no `update`, no Commands, no effects.

Reading and viewing:

```ts
Surface.read(surface, model, params)          // pure; does not fetch
Surface.read(surface, params)(model)          // data-last
Surface.view(surface, (model, h) => ...)       // infers projected Model and narrowed Message
Surface.registry(App, [ProjectCard, ...])      // explicit; no hidden global registry
```

View composition uses ordinary values, not a child registry:

```ts
const ProjectPage = Surface.define(App, "ProjectPage", {
  Params: Schema.Struct({ projectId: ProjectId }),
  model: ({ model, params }) =>
    Projection.struct({
      card: ProjectCard.projection({ projectId: params.projectId }),
      canNavigateBack: model.navigation.canNavigateBack,
    }),
  messages: [...ProjectCard.messages, Message.ClickedBack],
})
```

Composition invariant (statically checkable):

```text
child Model requirement ⊆ parent projected Model
AND
child Message set ⊆ parent Message set
```

Inside a child view, the `HtmlBuilder` remains narrowed to the child's own Message
set; the child cannot gain parent Messages.

### 5.4 Type-safety requirements

- Invalid Model fields, wrong nested Projections, wrong collection key types,
  Messages outside `App.Message`, and Messages not granted to a Surface view must
  fail at compile time.
- No explicit generic arguments and no manual TypeScript interface duplicating a
  Projection in normal use.
- Negative cases must be pinned with `@ts-expect-error` type tests.
- **Structural typing caveat:** two structurally identical Message variants from
  different unions may be compatible. Provide all safety Foldkit's representation
  allows; if strict nominal isolation becomes necessary, attach a hidden union
  identity to constructors without changing serialized values. Users must never
  manually reproduce a tag or payload in a Surface declaration.

### 5.5 Rejected alternatives (do not reintroduce)

- Magic Message tag strings (`"ClickedArchiveProject"`).
- Imperative capabilities (`send.archive(...)`).
- Selector callbacks whose dependencies are inferred by execution.
- Surface-owned Commands.
- A child registry.
- A normalized entity cache inside Surface.
- Inferring allowed Messages from what the view currently emits.
- Surface as a second mutation/action system.

---

## 6. Entity and Selection (Remote's data modeling)

### 6.1 Entity

`Entity` is a thin semantic wrapper over an ordinary `Schema.Struct`. The struct is
the single source of shape; Entity adds identity and normalization metadata.

```ts
const User = Entity.make(
  "User",
  Schema.Struct({
    id: UserId,
    name: Schema.String,
    avatarUrl: Schema.String,
  }),
)

const Project = Entity.make(
  "Project",
  Schema.Struct({
    id: ProjectId,
    name: Schema.String,
    status: ProjectStatus,
    owner: Entity.ref(User),
  }),
)
```

**Decision:** the `Schema.Struct` form above is canonical. The earlier
`Entity.make("User", { id, fields })` form (in `REMOTE.md` §6) is superseded — it
reduces Schema, which is exactly what the design principle forbids.

Derivations (no repetition outside the struct):

```ts
User.schema          // the Schema.Struct
User.fields          // === User.schema.fields
User.id              // typeof User.schema.fields.id  (the ID schema)
User.ref(userId)     // EntityRef<User>; requires the right branded ID
```

Constraint: entity roots must be `Schema.Struct` with an `id` field. Individual
fields may use any rich Effect Schema (`Schema.String.check(...)`, `Schema.Date`,
`Schema.NumberFromString`, brands, …). Constraining the root avoids needing to
solve union/transform/recursive/refinement as entity roots, and buys field lookup,
partial selection, patch schema derivation, and ID extraction for free.

### 6.2 Relations

The only thing Schema alone cannot express is "this is a relation to a normalized
entity, not a structurally equivalent object."

**Decision:** model a relation as an `Entity.ref` that is itself a Schema with
distinct decoded and encoded forms:

```text
decoded (application):   owner: User
encoded (normalized):    owner: EntityRef<User>   // User:u7
```

This uses Effect Schema's encoded/decoded distinction rather than inventing a
parallel relation-field codec. The domain representation is Option B in the
brainstorm (`owner: User`, nicer for selections and Sources); the normalized store
keeps the reference form internally. Prototype before committing: recursive entity
schemas and partial selections may complicate encoding.

### 6.3 Selection

A Selection is a derived Struct Schema plus remote requirement metadata.

```ts
const UserSummary = Selection.make(User, {
  id: true,
  name: true,
  avatarUrl: true,
})

const ProjectSummary = Selection.make(Project, {
  id: true,
  name: true,
  status: true,
  owner: UserSummary,
})
```

- `UserSummary.schema` exists at runtime (equivalent to
  `Schema.Struct({ id: UserId, name: Schema.String, avatarUrl: Schema.String })`).
- Keys are checked against the referenced Schema; they are not free-form strings.
- Nested selections compose recursively and retain requirement metadata.
- `Selection.union(a, b)` merges compatible field selections (data-first and
  pipeable); conflicting relation selections fail statically where possible and
  defensively at runtime.
- One declaration yields: static type, runtime validation, RPC codec, MCP/JSON
  Schema, cache validation, SSR serialization, and fixtures.

### 6.4 Patches

```ts
Entity.patch(Project.ref(id), { name: "Foo" })   // checked against Project.fields
Entity.patch(Project.ref(id), { banana: 1 })     // must not compile
Entity.patch(Project.ref(id), { status: 123 })   // must not compile
```

The patch schema is derived from the entity struct; no secondary field type system.

### 6.5 Query and Mutation

Both carry Effect Schema directly.

```ts
const ProjectsByOwner = Query.make("ProjectsByOwner", {
  Input: Schema.Struct({ ownerId: UserId }),
  Result: Query.connection(Project),
})

const RenameProject = Mutation.make("RenameProject", {
  Input: Schema.Struct({ id: ProjectId, name: Schema.String }),
  Output: Schema.Struct({ projectId: ProjectId }),
})
```

References and pagination:

```ts
const query = ProjectsByOwner.ref({ ownerId })
const page = pipe(query, Query.first(20))
```

A `QueryRef`'s identity is the encoded input plus descriptor plus pagination/window
(no hand-written cache-key arrays). Connection state stores entity **references**,
not copies, so an entity update flows to every connection that contains it.

---

## 7. Remote

`foldkit-remote` is not a networking, persistence, RPC, or database framework.
Effect provides those. Remote provides normalized application-facing server state:
typed entities and references, field selections, queries and connections,
mutations, field-presence tracking, declarative requirements, cache/request
planning, reconciliation, optimistic layers, Surface Projection integration, and
Foldkit Submodel integration.

### 7.1 Definition and binding

```ts
const Data = Remote.make({
  entities: [User, Project],
  queries: [ProjectsByOwner],
  mutations: [RenameProject],
})
// Data.Model, Data.Message, Data.update, Data.initial, Data.rpc, Data.registry
```

`Data.Model` is an ordinary Foldkit Submodel state embedded in the application
Model:

```ts
const Model = Schema.Struct({
  route: Route,
  session: Session,
  remote: Data.Model,
})

const App = Surface.make({ Model, Message })

const AppRemote = pipe(Data, Remote.at(App.model.remote))
```

**Decision:** the normalized cache is a Foldkit Submodel, not a hidden mutable
cache. Cache updates happen through Remote Messages (`ReceivedBatch`,
`ReceivedPatch`, …) processed by `Remote.update`, so DevTools sees cache evolution
and time travel can include it. Network code never mutates the store directly.

### 7.2 Model shape (internal)

```ts
interface RemoteModel {
  entities: EntityStore   // values + presence (+ tombstones)
  queries: QueryStore     // connection order + cursors, references not copies
  requests: RequestState
  mutations: MutationState
  optimistic: OptimisticLayers
}
```

Entity entries track **field presence** separately from values:

```ts
interface EntityEntry {
  readonly values: Record<FieldId, unknown>
  readonly present: FieldSet
}
```

The store must distinguish: missing, present `undefined`, present `null`, stale, and
not-found. Presence cannot be inferred from `value === undefined`. Tombstones make
absence cacheable so a missing entity is not refetched forever; they clear on
invalidation, live creation, cache reset, or an explicit mutation result.

### 7.3 RemoteData

A Schema-backed tagged union. **Decision — single representation, no ambiguity:**

```ts
type RemoteData<A> =
  | { readonly _tag: "Initial" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready";      readonly value: A }
  | { readonly _tag: "Refreshing"; readonly value: A }   // always carries the last value
  | { readonly _tag: "Failed";     readonly error: RemoteError; readonly previous?: A }
  | { readonly _tag: "NotFound" }
```

`RemoteData.match(...)` is exhaustive. There is no Suspense-like hidden control
flow; loading/error/data are visible application states.

### 7.4 Requirements and the planner

A Remote Projection produces a pure, immutable requirement tree:

```text
Project:p123
├ name
├ status
└ owner
   └ User
      ├ name
      └ avatarUrl
```

The most important pure function:

```ts
Remote.plan(remoteModel, requirements, { now })  // and pipeable
// => RequestPlan: the minimal missing/stale field selections per entity
```

Invariants:

- Planning is **deterministic**: same `RemoteModel` + requirements + freshness +
  `now` ⇒ same plan. `now` is injected (Effect `Clock` supplies it outside the
  planner); the planner never calls `Date.now()`.
- The planner emits the **missing fields only** (e.g. `Project:p123 { status }`,
  `User:u7 { avatarUrl }`), never whole entities or the whole Surface.
- Requirements are plain data: combinable, inspectable, serializable, diffable,
  and displayable in DevTools.

`Remote.execute(plan)` turns a plan into an Effect using the generated RPC client
(transport requirements stay downstream in the Layer graph).

### 7.5 Wire: Effect RPC, not a Remote transport

**Decision:** Remote defines RPC semantics; Effect RPC provides transport. Do not
create a `RemoteTransport` interface or `foldkit-remote-{http,ws,indexeddb,sql}`
packages.

Conceptually (verify exact syntax against rc.112):

```ts
const Read   = Rpc.make("FoldkitRemoteRead",   { payload: ReadBatch,        success: ReadBatchResult, error: RemoteReadError })
const Mutate = Rpc.make("FoldkitRemoteMutate", { payload: MutationRequest,   success: MutationResult,  error: RemoteMutationError })
const Live   = Rpc.make("FoldkitRemoteLive",   { payload: LiveRequirement,   success: RpcSchema.Stream(LivePatch), error: RemoteLiveError })
const RemoteRpc = RpcGroup.make(Read, Mutate, Live)
```

- Remote builds the semantic `ReadBatch` (batching is semantic, not transport
  dependent). Reads may dedupe/union/batch; **mutations preserve order and are
  never merged or auto-batched** (a future explicit transaction abstraction may
  batch them).
- Live data uses streaming RPC and merges normalized patches into the same store
  through Remote Messages.
- Application transport is chosen directly from Effect:
  `RpcClient.layerProtocolHttp({url})`, `layerProtocolSocket()`, etc.

### 7.6 Observation (I/O outside rendering)

`Surface.read` stays pure and never fetches. Fetching is a Foldkit Subscription:

```ts
const subscriptions = (model: Model) => [
  Remote.observe(AppRemote, ProjectPage, { projectId: model.route.projectId }),
]
```

`Remote.observe` extracts remote requirements from the Surface's Projection, diffs
them against `model.remote`, and produces a Subscription for the missing data.
Lower-level `Remote.observeProjection(AppRemote, projection)` exists because
Projection is the actual dependency description; Surface is composition/convenience.
`Remote.prefetch(...)` uses the same plan mechanism for SSR, route/hover prefetch,
agent preparation, and tests.

### 7.7 Mutations and optimistic layers

Mutations remain below Foldkit Messages: UI → Message → `update` → Command →
`Remote.mutate` → Effect RPC → Message → `update`. Remote is not a second action
system.

A mutation response carries a typed `Output` plus normalized cache patches:

```ts
{ output: { projectId }, entities: [Project.patch(projectId, { name })] }
```

Optimistic updates use layers, not inverse patches:

```text
base cache + optimistic patch #1 + #2 = visible cache
success → merge server patch, remove the layer
failure → remove the layer, revealing the base
```

`Remote.mutate(RenameProject, input, { optimistic: [Entity.patch(...)] })`. Do not
implement optimistic updates until ordinary mutation reconciliation is solid.

### 7.8 Query identity and connections

A `QueryRef` identity is the descriptor + canonical encoded input + pagination
window. Connection state stores references and cursors; entity updates propagate to
every connection automatically.

### 7.9 Persistence

**Decision:** delegate to Effect `KeyValueStore`/`Persistence`; do not build a
Remote storage abstraction or storage-specific packages.

```ts
RemotePersistence.save(Data, remoteModel, { key: "remote-cache" })
RemotePersistence.restore(Data, { key: "remote-cache" })
```

Remote data is server-derived and disposable: an incompatible persisted cache
should fail decode → clear → refetch. Do **not** copy Sync's stricter
preserve-and-recover policy (Sync may hold unsent user edits; Remote should not).
`PersistedCache` is `Request → Result`, a different cache from the entity store
(`Entity + Field → Value`); do not confuse them.

### 7.10 Server: `foldkit-remote-server`

Owns entity/query/mutation Sources, selection authorization, normalization, result
construction, and handler compilation. It does not own HTTP, WebSocket,
serialization, auth protocol, or DB connections.

```ts
const ProjectSource = RemoteServer.entity(Project, ({ ids, selection }) =>
  Effect.gen(function* () {
    const db = yield* Database
    return yield* loadProjects(db, ids, selection)
  }),
)

const RenameProjectSource = RemoteServer.mutation(RenameProject, ({ input }) =>
  Effect.gen(function* () {
    const db = yield* Database
    yield* renameProject(db, input)
    return RemoteServer.result({
      output: { projectId: input.id },
      entities: [Entity.patch(Project.ref(input.id), { name: input.name })],
    })
  }),
)

const Server = RemoteServer.make(Data, {
  entities: [UserSource, ProjectSource],
  queries: [ProjectsByOwnerSource],
  mutations: [RenameProjectSource],
})
```

- Runtime dependencies stay in the Effect environment (no captured `db`).
- **Selection authorization is mandatory**, separate from authentication.
  Authentication answers "who is this?" (Effect RPC middleware → `Principal`),
  Remote authorization answers "may this principal read this semantic
  field/entity?". A client must not be able to request `passwordHash` and have a
  Source honor it blindly.
- Durable work uses Effect `PersistedQueue`/`Workflow`; `RemoteServer` may depend on
  `foldkit-durable` only through ordinary Source dependencies.

### 7.11 Errors, spans, introspection

- Schema-backed tagged errors only where Remote adds semantic meaning:
  `RemoteSelectionError`, `RemoteDecodeError`, `RemoteProtocolError`,
  `RemoteNotFoundError`, `RemoteUnauthorizedError`, `RemoteMutationError`,
  `RemoteVersionError`. Transport failures stay Effect RPC/client protocol errors.
- Spans: `FoldkitRemote.{plan,read,mutate,live,prefetch}` with name/field
  counts/cache hits/misses/batch size. Never attach sensitive values.
- Pure introspection for DevTools: `Remote.inspect`, `Remote.inspectEntity`,
  `Remote.inspectQuery`, `Remote.plan`. DevTools must not depend on private Map
  layouts.

---

## 8. Agent redesign

Agent keeps all of its policy — naming, descriptions, external input mapping,
availability, authorization, principal, completion, audit, cancellation. Surface
only supplies the Model projection and Message subset.

```ts
const AppAgent = Agent.define(App, "TodoAgent", {
  model: ({ model }) =>
    Projection.struct({
      todos: model.todos,
      selectedTodoId: model.selectedTodoId,
    }),
  capabilities: [
    Agent.capability(Message.RequestedCreateTodo, { description: "Create a todo" }),
    Agent.capability(Message.RequestedDeleteTodo, {
      description: "Delete a todo",
      available: model => Option.isSome(model.selectedTodoId),
    }),
  ],
})
// AppAgent.surface : Surface<Model, AgentContext, RequestedCreateTodo | RequestedDeleteTodo>
```

Deletions: `Agent.context({schema, select})`, `Agent.pick(Model, [...])`, and the
`schema`/`read` duplication in `Agent.resource`. A resource becomes
`Agent.resource("todos", { description, projection: App.model.todos.select(TodoList) })`.

Higher-level builders produce a Surface internally and expose it (`.surface`);
`Agent.fromSurface(...)` / `Sync.fromSurface(...)` are the escape hatches when a
Surface already exists. Protocol adapters (`webmcp`/`mcp`/`a2a`/`native`) consume
the compiled Agent, not Surface/ModelRefs, and change very little.

**Opt-in exposure is separate from capability.** Declaring a Message in a Surface
means "this feature may produce it", not "remote agents are authorized to". Coding
agent exposure remains explicit (`Mcp.exposeSurfaces(Surfaces, { allow: [...] })`);
DevTools may inspect everything in development.

---

## 9. Sync redesign

Sync keeps the offline replica, replay, reconciliation, and presence. It stops
hand-rolling a projection and consumes Surface.

```ts
const TodoSync = Sync.define(App, "Todos", {
  documentId: documentId("todos"),
  model: Sync.project({ todos: App.model.todos }),  // writable projection from ModelRefs
  messages: [Message.CreatedTodo, Message.RenamedTodo, Message.DeletedTodo],
  replay: updateShared,
})
// TodoSync.surface : observes/writes Model.todos, accepts those Messages
```

- `Sync.project({...})` is a **writable** projection derived from `ModelRef`s
  (`ModelRef` carries `get`/`set` internally). This deletes `sync/src/projection.ts`.
- Surface projections stay read-only publicly; only Sync's specialization regains
  write authority.
- `replay` is inferred against only the declared Message subset, not the whole
  application union.
- The low-level `defineSync({ message, shared, empty, durable, replay })` remains as
  the protocol primitive and escape hatch; `Sync.define` compiles down to it.
- Durable stays independent. Sync produces the replay contract:

```ts
const journal = yield* makeJournal({
  ...Sync.journalContract(TodoSync),   // { operation:{encode,decode}, snapshot:{encode,decode}, empty, reduce }
  file, opId, actorId, validate, authorize,
})
```

So both halves of replicated state derive from the same application contract, while
`foldkit-durable` remains useful on its own.

---

## 10. Durable

Unchanged semantics: ordered Message log, authoritative replay, snapshot + cursor,
Message idempotency, effect ledger. It must not depend on Surface for conceptual
neatness.

Review, later, whether its internals should reuse Effect
`EventJournal`/`EventLog`/`PersistedQueue`/`Workflow` where that preserves
Foldkit-specific semantics without adding a dependency. No `foldkit-remote-durable`
package.

---

## 11. Cross-cutting invariants

- **One owner per datum.** A logical piece of state has exactly one authoritative
  owner: local UI/process state → Foldkit Model; server-derived disposable entity
  data → `foldkit-remote`; replicated/offline domain state → `foldkit-sync`. Never
  store the same domain object in both Remote and Sync. A Surface may compose all
  three; ownership does not blur.
- **Use Remote for disposable server data** (search, catalog, profiles, analytics,
  large read-heavy graphs, pagination, server-computed values). **Use Sync for
  client-owned replicated state** (collaborative docs, todos/boards, offline edits,
  multi-device shared state).
- **No implicit dependency tracking, ever.**
- **Capability ≠ authorization.** A Surface's Message set and an agent's exposure
  are declarations of possibility; authorization is explicit policy.
- **Determinism.** Replay and the planner are pure; nondeterministic inputs
  (time, ids) enter through Messages/parameters.
- **Effect owns infrastructure.** Transport, serialization, storage backends,
  queues, workflows, SQL lifecycle, and KV are Effect's. Foldkit Plus owns semantic
  data modeling and Foldkit integration.
- **Small semantic core, many interpreters.** Surface stays small; DevTools, SSR,
  MCP, Scene, render optimization, and architecture linting consume descriptors
  rather than enlarge them.

---

## 12. Decision log (where the source docs disagreed)

| Topic | Decision | Reason |
| --- | --- | --- |
| `Entity.make` shape | `Entity.make(name, Schema.Struct({...}))` | Brainstorm supersedes `REMOTE.md` §6's `{id, fields}`; never reduce Schema. |
| Entity field namespace | `User.fields === User.schema.fields` | No second field namespace. |
| `ModelRef` read/write | Internal `get`/`set` via Optic; public Projection read-only | Sync needs a writable projection without granting UI mutation authority. |
| Dependency discovery | Declared by typed access, never Proxy-executed selectors | Matches design principle 3.6; avoids implicit runtime behavior. |
| `RemoteData` | Tagged union with `Refreshing<A>`/`Failed<A>` carrying the last value | Removes the "may retain previous" ambiguity; exhaustive matching. |
| Remote cache | Foldkit Submodel inside the app Model | Keeps cache in DevTools/time travel; no hidden cache. |
| Field presence | Separate `values` + `present` sets, plus tombstones | `undefined`/`null`/absent/unfetched are distinct. |
| Wire | Effect RPC; no `RemoteTransport` | Remote owns semantics, Effect owns transport. |
| Persistence | Effect `KeyValueStore`; Remote cache disposable | Remote data is server-derived; clear-and-refetch is correct recovery. |
| Mutations | Via Commands; typed Output + cache patches | Preserves the Foldkit transition system; no alternate action system. |
| Planner | Pure, deterministic, `now` injected | Testable and DevTools-visible. |
| Agent exposure | Separate opt-in, not implied by a Surface | Compile-time capability is not an authorization boundary. |
| Package names | In-repo `foldkit-surface` / `foldkit-remote` / `foldkit-remote-server`; Surface kept upstreamable | Matches repo convention; does not block on an upstream decision. |
| Durable | Stays independent; Sync provides the journal contract | Owns ordering/storage, not app semantics. |
| Low-level Sync | `defineSync` retained as escape hatch | Non-Foldkit and unusual consumers. |

---

## 13. Execution phases

Ordering principle: prove inference before architecture; prove pure semantics
before networking; keep each phase independently reversible.

### Phase 0 — Inference spike (do this first, and stop if it fails)

A throwaway `packages/surface` (or a scratch file) that proves, with
`@ts-expect-error` negatives and mutation-verified positives:

1. `App.model.session.user.name` yields a `ModelRef<Model, string>` with the right
   optic and dependency path; `.at(key)` yields an optional focus; `.index(i)` works.
2. `Projection.of(Schema)({...})` checks nested projections and rejects bad keys;
   `Projection.struct(...)` infers the combined value and unions dependencies.
3. `Surface.define`/`Surface.view` narrow the projected Model and the
   `HtmlBuilder` Message set; a child view composes into a parent whose Message set
   is a superset; an undeclared Message does not compile.
4. `Remote.make({entities}).Model` embeds as a Submodel without widening to `any`;
   `Remote.select` yields `RemoteData<...>`.
5. A `Selection.make` derives a runtime Schema; `Entity.patch` rejects unknown/wrong
   fields.

If any of these cannot be made ergonomic (no explicit generics, no casts), the
architecture must change before implementation. Record results in this document.

### Phase 1 — `foldkit-surface` core

`ModelRef` tree, `Projection.{of,struct,array,option,read}`, `Surface.{make,define,
read,view,registry}`. No Runtime changes, no optimization, no MCP. Acceptance:
excellent inference, zero annotations in normal use, negative type tests.

### Phase 2 — Composition proof

Surface-in-Surface, Submodel + Surface, parameterized Surfaces, Option/Record/Array
projections, parent Message supersets. Validate against real Foldkit examples
(Kanban, auth, cart, typing game) before expanding.

### Phase 3 — Pure Remote core

`Entity`, `EntityRef`, `Selection`, `RemoteData`, normalized `EntityStore`, field
presence, tombstones, `Requirement`, `Remote.plan`, `Remote.merge`. **No network,
no RPC, no database.** This proves the semantics.

### Phase 4 — Remote↔Surface integration

`Remote.make`, `Remote.at`, `Remote.select`, remote Projection nodes, Surface
requirement extraction. Prove local + remote mixed Projections.

### Phase 5 — Queries and connections

`Query.make`, `QueryRef`, connections, pagination, query cache, connection
normalization. Still no transport.

### Phase 6 — Effect RPC wire

Remote RPC group (`Read`/`Mutate`/`Live`) using `effect/unstable/rpc`. Verify exact
rc.112 API surface (`RpcClient`/`RpcServer` layers, streaming).

### Phase 7 — `foldkit-remote-server`

Entity/Query/Mutation Sources, selection authorization, handler compilation,
normalization, `RemoteServer.make`/`handlers`.

### Phase 8 — Observation

`Remote.observe`, `Remote.observeProjection`, `Remote.prefetch` via Foldkit
Subscriptions/Commands and Effect RPC Effects.

### Phase 9 — Mutations

`Mutation.make`, `Remote.mutate`, mutation status, cache patches, typed Output.
Optimistic layers come after ordinary reconciliation is solid.

### Phase 10 — Optimistic layers

`Entity.patch`, optimistic layers, settle success/failure, overlapping-rebase proof.

### Phase 11 — Live streaming

Effect streaming RPC merged through the same normalized cache. No parallel
live-state architecture.

### Phase 12 — Persistence and SSR

`RemotePersistence` over Effect `KeyValueStore`; `Remote.prefetch` +
in-process RPC for SSR; cache serialization and hydration.

### Phase 13 — Rebuild Agent and Sync on Surface

Delete the duplicated projections; wire `Sync.journalContract`; keep adapters
leaf-only. Then, and only then, evaluate optional adapters
(`foldkit-remote-drizzle`) against real repeated Source boilerplate.

### Phase 14 — Tooling

`Surface.registry`, DevTools Surface inspection, dependency and capability display,
optional development MCP exposure. No behavior changes.

---

## 14. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Inference (ModelRef tree, nested Projections, Submodel Model, view subset) | **Critical** | Phase 0 spike with negative type tests before any architecture. |
| `HtmlBuilder` subset variance for `Surface.view` | High | Spike; fallback is a branded builder or a small Foldkit core seam. |
| `Remote.make` Model widening to `any` | High | Prefer a runtime registry + small scope brand over giant conditional unions; negative type tests. |
| Message union identity is structural | Medium | Provide all structural safety; decide on a hidden union brand early. |
| `effect/unstable/rpc`/`persistence` churn | Medium | Pin to rc.112, re-verify syntax at implementation; isolate in one module. |
| Scope (5 packages, rewrite Agent+Sync) | High | Phased, independently reversible; keep published packages working until their replacement ships. |
| Concurrent sessions editing the tree | Medium | Stage only owned files; never `git add -A`; coordinate on `packages/surface/`. |
| Performance of the normalized store in the Model | Medium | Treat render optimization as a later interpreter; correctness first. |

---

## 15. Testing and verification

- Every phase ships with tests, and every guard is **mutation-verified** (break
  the code, watch the test fail, revert).
- Inference is pinned with `*.test-d.ts` and `@ts-expect-error` negatives; an
  unused directive must fail `tsc`.
- Planner, merge, and replay are pure and property-tested over generated
  models/requirements.
- Field-presence and tombstone behavior get explicit cases (missing vs
  present-undefined vs present-null vs stale vs not-found).
- RPC layers are tested with Effect's in-process/test RPC tooling, not a bespoke
  transport fake.
- The four CI checks stay mandatory: `format:check`, `typecheck`, `test`, `demo`
  (plus `pack:check` for manifest/build changes).

---

## 16. Release and migration

- New packages start private, version `0.0.0`, unpublished until Phase 1/3
  acceptance holds.
- Existing published packages keep working: `foldkit-agent*`, `foldkit-sync@0.2.0`,
  `foldkit-durable@0.1.1`. Do not break them until their Surface-based replacement
  is proven and a migration path exists.
- The Surface-based Agent and Sync APIs are breaking; ship them under new minor
  versions with deprecation notes, or as new packages, once Phase 13 lands.
- `foldkit-durable` is unaffected and needs no migration.
- Update `CHANGELOG.md`, the root umbrella README, and the affected package
  READMEs as each phase lands. `PLAN.md` (git-ignored) remains the scratch tracker;
  this document is the durable plan.

---

## 17. Immediate next step

Phase 0. Build the smallest possible inference spike (one scratch module plus
`*.test-d.ts`) covering the five cases in §13, run `pnpm typecheck` and `pnpm test`,
and record the results in a new "Phase 0 results" section here. Do not begin
Phase 1 until every case infers without explicit generics or casts — or until the
document is amended with the architecture changes the failures imply.

Open questions to resolve before or during Phase 0:

1. In-repo vs upstream: build `foldkit-surface` here (recommended for now), and
   keep it upstreamable, or propose it to Foldkit first?
2. Does `HtmlBuilder<Message>` support the subset narrowing `Surface.view` needs,
   or is a Foldkit core seam required?
3. Do we attach a hidden union identity to Message constructors for nominal
   application isolation?
4. Which existing example(s) become the first real validation target for Phase 2?
