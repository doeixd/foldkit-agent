# Changelog

All notable changes to this project are recorded here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) per package and is
released from a version tag (`vX.Y.Z`). A release only republishes packages whose
version changed; `pnpm` skips versions already in the registry.

## Unreleased

Correctness fixes from a review of the implementation, the `foldkit-surface`
reference-selection work and the `foldkit-remote` submodel, and the first
published `foldkit-agent-native`. Breaking for `foldkit-sync` (the storage and
presence APIs), `foldkit-durable` (`append`'s result), and `foldkit-remote`
(`RemoteModel` and the mutation/observe signatures).

### `foldkit-surface` (private)

- **`Module`, the pure composition root.** `Module.make(App, [contracts])`
  collects an application's contracts as data; `Module.validate` reports a
  contract from another application, a duplicate `kind:name`, two owners of
  overlapping Model paths, a Message durable in two replication contracts, and
  a path or Message the application does not declare; `Module.manifest`,
  `Module.toMarkdown`, and `Module.toMermaid` show who owns each Model path (local, sync, or remote) and
  every contract's observes/messages/requirements. A `Contract` is the shared
  description: `Surface.contract` derives one from a Surface, and Sync, Remote,
  and Agent attach one to the values they produce. `Surface.registry` is
  removed; `Module` is the explicit collection (#60, sections 1 and 8).
- **The primitives are first-class.** `Projection.pick`/`Projection.compose`
  (were `Surface.pick`/`Surface.compose`) build writable projections, and
  `MessageSet.make(App, [constructors])`/`MessageSet.union` (were
  `Surface.messages`/`Surface.unionMessages`) build typed Message subsets, now
  typed `MessageSet`. Agent and Sync consume `Projection` and `MessageSet`
  values, not Surface helpers; a `Surface` is what composes one of each with a
  name and a renderer (#60, section 4).
- **`make` constructs, `application` scopes.** One vocabulary across the
  application-contract packages (#60): `forApplication(App)` specializes a
  package to an application and `make(config)` constructs a contract, as
  `Ref.make`/`Queue.make` do in Effect and `Remote.make`/`Entity.make` already
  did here. `Surface.define(App, name, config)` is now `Surface.make`, and the
  scope-only `Surface.make({ Model, Message })` is folded into
  `Surface.application`, which already accepted a config without
  `initial`/`update`. The mixins packages keep their own `Slots.define`/
  `SurfaceView.define` vocabulary for now.
- **Reference-based selection.** `Surface.application` generates a reference tree
  (`App.fields`), and `Projection.pick`/`Projection.compose` build writable projections
  from it, so a shared projection is derived from the Model Schema instead of
  declared twice. `Sync.forApplication` and `Agent.forApplication` consume it.
- **Typed Message subsets.** `MessageSet.make(app, [constructors])` and
  `MessageSet.union(...)` produce a `MessageSet` with a pure codec, a tag
  set, and an owner token, so two structurally identical applications cannot mix
  selections and a subset cannot leak across applications.
- **Encoded types are preserved.** `ModelRef`/`FieldRef` and `MessageSet` carry
  an `Encoded` parameter, so a transforming field (`Schema.NumberFromString`)
  keeps its encoded type through `Projection.pick` and the journal snapshot codec
  instead of widening to `unknown`.
- **Transition and resources.** `Surface.application` accepts optional
  `initial`/`update` and resource-carrying Commands; the runnable form is what
  `Agent.forApplication` and `Sync.forApplication` require.

### `foldkit-remote` (private)

- **Review hardening.** One plan: `Remote.plan(bound, model, projection,
  options?)` replaces `planProjection`/`observeProjection`/`planSurface`
  (a Surface's is `surface.projection(params)`); `Remote.retain(projections,
  toMessage?, options)` drops the bound remote, and `observe`/`live`/`retain`
  default `toMessage` to the identity; `Remote.storeOf(bound, model)` is the
  visible store (base under pending layers), memoized per model state so every
  read and plan of one render shares it; `Remote.live` takes `{ now }`;
  `Remote.visibleItems` and `RetainOptions.connections` accept a `QueryRef`.
  A merged cursor page keeps the stored page's near boundary instead of
  inventing one, and pages merged within one read result see each other.
  `ConnectionChange.prepend`/`append`/`remove` (was `Optimistic.*`) build the
  connection half of `MutateOptions.optimistic`; `OptimisticState` is the
  model slice. Persistence is namespace-only (`RemotePersistence.*`); the
  wire caps `MAX_FIELDS_PER_REQUEST` (256) and `MAX_RELATION_DEPTH` (8) with
  static nesting; `Entity.patch` takes wire-shaped values; `Selection.make`
  refuses an empty selection, which would require nothing and read `Ready`.
  `Remote.clientLayer` is generic in the RPC client's requirements, so
  in-process `RemoteServer.handlers` over a database become a `RemoteClient`
  with one `Layer.provide` instead of a hand-written adapter.
- **Recursive nested selections.** `Selection.make(Project, { owner:
  UserSummary })` now reads through the ref into the target instead of failing
  to decode: the field codec follows the entity field's shape (ref, nullable
  ref, array of refs, or a page of refs through
  `Selection.connection(Entity, window, nested)`, which reads a `Page` of
  items), `Remote.select` assembles every level from the normalized store and
  reads `Initial` until each is present, and the requirement carries the graph
  (`relations`, on `foldkit-surface`'s `Requirement`, with `Requirement.merge`
  and `Requirement.mergeRelation`). `plan` attaches a relation to a field
  being fetched and follows a known relation's refs into concrete
  requirements. `Entity.ref`/`refPage` codecs are annotated, and `refsIn` /
  `relationShape` are exported. Breaking wire change: `ReadBatch` and
  `LiveRequirement` carry `REMOTE_PROTOCOL_VERSION` (now 3), `ReadRequest` gains
  `relations`, and a version mismatch fails with `RemoteProtocolError`
  (`RemoteClient.read`/`live` error types widen accordingly) (#65, section 1).
- **One statement per windowed relation.** `foldkit-remote-drizzle` ranks a
  windowed relation's children per parent in a window function and keeps the
  first `pageSize + 1` of each, so a `Selection.connection` over many parents
  no longer runs one page query per parent; the statement count of a windowed
  nested read no longer grows with the number of parents (#65, Phase E item 16).
  Its `source` declares the binding's fields (`EntitySource.fields`), so the
  server never asks it for another; `first: 0` is honored as a page of
  boundaries only rather than falling back to the default size;
  `returning(binding, fields)` pairs a mutation's `returning` columns with
  the normalization of the rows they yield.
- **Property tests and two fixes they found.** Seeded property checks over
  connection merge, live event ordering, and optimistic convergence. `merge`
  now puts a terminal-start segment first and a terminal-end segment last, so
  a gap never reorders the sides; `foldkit-remote-server` chunks a nested
  level's fan-out by `maxIdsPerEntity` instead of refusing it (#65, Phase E).
- **The durable boundary, stated.** The README says what a Remote mutation is
  (an immediate, server-derived command) and what it is not (durable intent,
  which `foldkit-sync`/`foldkit-durable` own); no second queue (#65, section 9).
- **Hydration hardening.** Snapshots are deterministic (equal stores give
  byte-equal text), carry a `scope`, and respect `maxBytes` on save and
  restore; `dehydrate`/`hydrate` are the text forms for SSR, `mergeStores`
  and the new `Hydrated { entities, merge }` Message bring one into the Model
  by `replace` or `preserve-existing`, and runtime state is never in a
  snapshot. `REMOTE_CACHE_VERSION` is 3; `stableStringify` is exported (#65,
  section 8).
- **Live pruning.** A live `ConnectionRemove` hides a server-known edge (a
  `remove` overlay), not only a pending insert; `ConnectionMerged` prunes the
  settled overlays a page supersedes and leaves a pending request's alone;
  `visibleItems` skips an edge whose target is a tombstone when given the
  store, and `Remote.visibleItems(model, connection)` reads all of it (#65,
  section 7).
- **A mutation owns its optimistic operations.** `MutationStarted { requestId,
  optimistic }` applies entity patches (`Entity.patch`) and connection changes
  (`ConnectionChange.prepend`/`append`/`remove`, new) as a layer and overlays owned
  by the request; `MutationSucceeded` releases both and records the result's
  confirmed `connections` (new on `MutationResult` and the server's
  `MutationOutcome`) in the same position, and `MutationFailed` drops both.
  `visibleItems` reads pending prepends newest-first and hides `remove`
  overlays. Breaking: `OptimisticAdded`/`OptimisticRemoved` are gone,
  `Remote.mutate` returns `connections`, `Remote.mutateInto` takes
  `{ optimistic }`, and the protocol version is 3 (#65, section 5).
- **Coalesced reads.** `Remote.clientLayer` (and `Remote.coalesced` for a
  hand-written client) batch requirements issued together into one
  `ReadBatch`, union overlapping fields, join a requirement already in flight,
  and release it when the read fails; built on Effect's `RequestResolver`
  with an optional `window` (#65, section 2).
- **Cache retention.** `Remote.retain(projections, toMessage?, {
  connections, grace })` is a Subscription entry whose dependencies are the
  retention roots; it emits the new `RetentionChanged` Message after `grace`,
  and `Remote.update` applies the pure `gc(state, roots)`, keeping what the
  roots reach through refs and nested relations, retained connections' edges,
  and pending optimistic layers and overlays (#65, section 3).
- **Request policies.** `RemotePolicy.cacheFirst` / `staleWhileRevalidate({
  maxAge })` / `networkOnly` on `Remote.observe` and `Remote.prefetch` decide
  what a field the store already holds means. A refreshing policy emits
  `RefreshStarted` (new `RemoteMessage`) before the read, marking the refetched
  fields stale so `Remote.select` reads `Refreshing`, which was unreachable
  before. Breaking: the pure planners take `PlanOptions` (`{ freshness, force }`)
  instead of a bare `PlanFreshness`, and `prefetch` takes `{ policy, now }`
  instead of `{ freshness }` (#65, section 4).
- **A `Contract` for `Module`.** `Remote.at` attaches `contract`: the bound
  Remote owns its store's Model path, named after it.
- **A real Remote submodel.** `RemoteModel` is the four producers' shared state
  (`entities`, `connections`, `optimistic`, `live`, `mutations`, `gaps`), and
  `Remote.update` is the single reducer over reads, mutation results, live events,
  connection merges, and optimistic layers. `Remote.make` returns
  `Model`/`initial`/`Message`/`update`/`rpc`. A live event ahead of its cursor
  records a gap instead of being applied out of order.
- **Entity-aware selections.** `Remote.at` carries the domain's registered entity
  names and `Remote.select` is constrained to them, so a selection for an entity
  the domain never declared is a compile error. `Selection.schema` is a pure
  codec, removing a decode cast.
- **Mutation reconciliation.** `Remote.mutate` returns the result's normalized
  patches (previously dropped) and `Remote.mutateInto` reconciles them and returns
  the new Model; settling is idempotent per `requestId`.
- **Simpler observation.** `observe`/`live` emit a `RemoteMessage` through a single
  handler, and `Remote.live` reads its resume cursor from `RemoteModel.live`
  instead of a callback the application cannot key. `Remote.prefetch` accepts a
  freshness window; the pure planners take `PlanFreshness`. `RemoteData.schema` is
  exported.
- **Queries and introspection.** `Remote.query`/`Remote.queryMessage` consume a
  `QueryRef` end to end, and `Remote.inspect`/`Remote.inspectEntity` expose a pure,
  serializable cache view for DevTools.
- **Gap lifecycle.** A live stream's gap clears when an in-order event applies or
  a `GapCleared` message arrives, rather than sticking forever.
- **Self-describing refs and a registry.** `QueryRef` carries its input codec, so
  `Remote.query(ref)` needs no descriptor; `Remote.make` builds a name-keyed
  `registry` from the declared entities, queries, and mutations.
- **An RPC client adapter.** `Remote.clientLayer(rpcClient)` turns an Effect RPC
  client for `RemoteRpc` into a `RemoteClient`, reconstructing the client's
  `LiveEvent` from the wire's `LiveChange` so the mapping is not re-invented per
  application.

### `foldkit-remote-server` (private)

- **Review hardening.** A request for a field the Entity does not declare
  never reaches `read` or `authorize` (`RemoteServer.entity(Project, …)`
  records the declared fields; `EntitySource.fields`); the per-entity id cap
  counts a batch's distinct ids across its window groups, and a live
  subscription is refused over the same cap; the wire refuses, rather than
  silently truncates, a selection nested past `MAX_RELATION_DEPTH`.
  `RemoteServer.liveHub(entities)` takes the entity sources, so the mutation
  sources that signal it can be built after it; subscribers sharing a
  principal share a read by the principal's identity, not its serialization;
  `HandlerOptions<P, R>` types the hub; `RemoteServer.prepend`/`append`/
  `remove(connection, ref)` build a mutation outcome's connection changes.
- **A live hub.** `RemoteServer.liveHub(entities)` tracks each live
  subscriber's requirements and principal; `hub.changed(ref, fields)` re-reads
  the changed fields a subscriber selects through the entity source under its
  principal and streams the patch, `hub.deleted(ref)` streams a delete, and
  `handlers(server, principal, { live: hub })` registers every subscription
  (#65, section 6).
- **Nested resolution in one read.** `FoldkitRemoteRead` resolves a request's
  `relations` level by level: each level's refs become the next level's
  requests, a target the batch already read is not read again, every level is
  authorized through its own entity source, and `HandlerOptions.maxDepth`
  (default 8) caps traversal. Both read and live handlers refuse another
  protocol version with `RemoteProtocolError` (#65, section 1).

- **Live handler.** `RemoteServer.live` and the compiled `FoldkitRemoteLive`
  handler were missing; the server can now stream the client's live requirements.
  Two wire bugs are fixed with it: `LiveRequirement` was missing the resume cursor
  and `LivePatch.cursor` was a string while the client cursor is numeric.
- **Typed live changes.** The live wire success is now a `LiveChange` union of
  entity patches, deletes, and connection insert/remove/invalidate events, so a
  connection change can travel over the wire instead of entity patches only.
- **Less ceremony.** `RemoteServer.make` drops its unused domain argument, and the
  server imports the canonical `NormalizedPatch` instead of duplicating it.

### `foldkit-agent-native`

- **Published.** The Agent Native adapter leaves prototype status at `0.1.0`.
  `AgentNative.actions` compiles an exposed contract into registry entries whose
  `run` only dispatches, and advertises the encoded input schema as a Standard
  Schema validator. It remains pinned to `@agent-native/core@0.177.1`.

### `foldkit-mixins` (private)

- **Slot contracts.** New private package: branded Capability / Event / Attr
  tokens and `Slots.define` contracts.
- **Resolver.** A `Mixin` contribution model and a pure, deterministic
  `Resolver.resolve`: additive deduplicated classes, per-property inline styles,
  single-owner events and scalar attributes, protected slots, opaque
  `ChildAttribute` preservation, and one composed `OnMount`. Conflicts throw a
  structured `DiagnosticError`.
- **SlotView.** `SlotView.define` publishes typed Slots and resolves attached
  Mixins per slot into ordinary Foldkit attributes; `SlotView.attach` is
  immutable.
- **Style v1.** Pure `Style.class`/`inline`/`compose`/`when`/`forSlots`, compiling
  to a contribution; `Style.attach` is `SlotView.attach` for a style.
- **Input-driven Style.** `Style.whenInput(predicate, piece)` defers a piece to
  render time, folded against the view's input and composable (including nested
  conditions). It compiles to a message-free `Mixin<never>`; the mixin boundaries
  accept `Mixin<never>` explicitly because it does not widen to `Mixin<Message>`.
  The CSS compiler is not in this slice.
- **Behavior v1.** `Behavior.slot`/`forSlots` build attributes from the view's
  `input` and `h` at resolve time, so the view's Message universe governs them.
  Definition-time validation rejects an unknown slot, an unsatisfied capability,
  and an unpublished event or attribute; a Behavior owns no state.
- **Mount runtime coverage.** Composition is tested through `foldkit/test`'s
  `Scene` (two Behaviors yield exactly one observed Mount) and directly on the
  merged stream: every inner stream's Messages are collected, and a failing
  inner stream fails the merge rather than being swallowed.
- **Theme and recipes.** `Theme.define` is typed token data, with
  `Theme.variable`/`Theme.variables` compiling to CSS custom properties;
  `Style.recipe` is a typed variant selector returning Style data, with
  `compound` combinations matched against the resolved selection.
- **Advanced Style compiler (started).** `Style.pseudo`/`media`/`supports`/
  `container`/`nest` compile to a deterministic class (FNV-1a of the canonical
  rule text) plus CSS text; `Style.keyframes` and `Style.global` contribute
  class-independent CSS. Declarations are kebab-cased and equal rules share a
  class. `NamedStyle.css`/`globalCss` plus structured `rules`/`globalRules`, and
  `Style.stylesheet`, expose deduplicated CSS as data, so SSR and the browser
  agree and nothing mutates the DOM. Rules inside `Style.whenInput` are rejected
  (`style:conditional-rules-unsupported`). Render-time collection/extraction is
  still out of scope.
- **A11y patterns.** `A11y.pattern` is a portable requirements map and
  `A11y.validate` reports every mismatch as a stable `a11y:*` diagnostic
  (missing or hidden slot, capability mismatch, missing event or attribute). It
  is pure and DOM-independent. The UI/Surface adapters are not in this slice.
- **Prototype-key slot names.** `Style`, `Behavior`, `Mixin.compose`,
  `Style.compose`, `Slots.describe`, the `SlotView` builders, and the
  `@foldkit/ui` resolver accumulate into prototype-free records, so a slot or
  style named `__proto__` keeps its contribution instead of silently becoming
  the accumulator's prototype.

### `foldkit-mixins-ui` (private)

- **`@foldkit/ui` adapter.** New private package formalizing the attribute
  bundles of Button, Input, Textarea, Select, Checkbox, Switch, Fieldset, and
  Disclosure as `Slots`, and resolving attached Mixins into them. Base
  attributes, event Messages and `ChildAttribute`s are preserved; a Behavior
  cannot take over an event the component already owns.
- **Submodel adapter.** Dialog's seven `ChildAttribute` groups are published as
  `DialogSlots`; `resolve` preserves them by identity and passes `isVisible`
  through. Popover's four groups (with its anchor/portal Mounts), Tooltip's two,
  and Slider's six are published the same way. All are tested DOM-free with
  `foldkit/test`'s `Scene`, so real ChildAttributes exercise the resolver,
  including the owned close/trigger `click`, `focus` or `pointerdown`.
  `Event.Cancel` was added for the dialog's Escape handler.
- **Nested Submodels.** Tabs, RadioGroup and Calendar publish per-item groups
  (`tabs[i].tab`/`panel`, `options[i].option`/`label`/`description`,
  `weeks[].cells[].cellAttributes`/`buttonAttributes`). Their adapters call
  `SlotView.buildersFor` directly and map each item, so one slot contribution
  applies to every item while each item's base keeps its own event ownership.
  Tested through `Scene` with identity, Style and conflict assertions.
- **Out of reach with this seam.** `Menu`, `Listbox`, `ComboBox` and `DatePicker`
  own their markup and expose no `toView`/attribute bundles, so there is nothing
  to resolve against.

### `foldkit-mixins-surface` (private)

- **SurfaceView bridge.** `SurfaceView.define(surface, slots, render)` binds a
  Surface's projected Model and Message subset to a core `SlotView`: the
  renderer's input is the projection, and its builder is typed with the
  Surface's Message subset, so a Behavior cannot emit a message the Surface does
  not expose. The result is an ordinary `SlotView`, so Style/Behavior attach and
  pipe unchanged; `SurfaceView.toRenderer` adapts it to `Surface.view` /
  `Surface.rootView`. Type tests pin the projected-Model and Message-subset
  rejections, and runtime tests drive `Surface.rootView` end-to-end, including a
  Style and a Behavior reading the projected input. `SurfaceView.inspect(view)`
  returns serializable `{ name, slots, mixins }` (no functions), composing with
  `Surface.inspect`. `SurfaceView.describe(surface, params, view)` merges both
  into one serializable description (emitted Messages as tags, not constructors),
  with a deterministic `toMarkdown` for docs and CI. A `@foldkit/ui` component
  composes inside a SurfaceView: the Surface's Message subset flows into its
  config and a Mixin resolves around its bundle. Phase 10 started, not complete.

### `foldkit-mixins-example` (example)

- **Worked Surface + Mixins trace.** A `ProjectCard` Surface projects two fields
  and exposes two of the application's Messages; a SlotView styles and decorates
  it (`Style.whenInput`, `Style.pseudo`, a Behavior reading the projected input).
  The demo prints the observation set, slot contracts, mixin names, projected
  model, resolved attributes, the compiled stylesheet, and the serializable
  `SurfaceView.describe` value plus its `toMarkdown`; `pnpm demo` runs it and a
  test asserts every line. Remote is not part of this example.

### `foldkit-kitchen-sink` (example)

- The transcript now runs the whole Remote path end to end: a nested `owner`
  selection over Drizzle, a live subscription fed by the server's hub from the
  rename mutation, an optimistic insert into the projects connection confirmed
  in place by the mutation result, and a dehydrate/hydrate round trip that
  leaves nothing to fetch (#65, Phase E).

### `foldkit-remote-example` (example)

- **Remote-backed trace.** A `ProjectPage` Surface selects a project out of a
  `foldkit-remote` store; `Remote.plan` reports the requirement,
  `Remote.prefetch` fills it against an in-process `RemoteClient`, the projected
  `RemoteData` moves `Initial → Ready`, a SurfaceView styles and decorates it, a
  `Remote.mutateInto` rename is visible through the same projection, and a
  malformed stored value surfaces as `Failed`. `pnpm demo` runs it; a test asserts
  every line.

### `foldkit-agent`

- **A Surface as context.** `Agent.forApplication(App).make({ context })` accepts
  a feature Surface (without params) beside a `Projection` or a writable pick,
  so the Surface a view renders is also what the agent sees (#60, section 3).
- **A `Contract` for `Module`.** `Agent.forApplication(App).make` attaches
  `contract`: what the agent observes (its context projection) and the Message
  tags it exposes; `name` (default `'agent'`) names it. `Agent.make` alone
  cannot know the application and attaches none.
- **`define` is `make`.** `Agent.define`, `Agent.forModel<Model>().define`, and
  `Agent.forApplication(App).define` are `make`, and `DefineOptions` is
  `MakeOptions`, matching `Sync.forApplication(App).make` and `Surface.make`
  (#60). `Definition` keeps its name: it is what `make` returns.
- **Surface-based context.** `Agent.context` and `Agent.pick` are removed. The
  `make` `context` option now takes a `foldkit-surface` projection — a read-only
  `Projection` (`Projection.of`/`struct`/`fromReader`) or a writable
  `Projection.pick`/`Projection.compose` — and the runtime reads it with `.read`.
  `Agent.forApplication(App)` infers the Model from a `Surface.application` and
  accepts either projection directly; `Agent.forModel<Model>()` remains when there
  is no application. `Agent.contextSchema` is unchanged.
- **Subset exposure and a curried principal.** `Agent.exposeSubset(subset,
  variants)` exposes only the variants of a `MessageSet.make` subset, and
  `MessageSet.union` composes disjoint subsets. `Agent.forApplication` infers
  the Model, so a `Principal` is supplied by
  `Agent.forApplication(App).withPrincipal<Principal>()` — TypeScript cannot
  infer Model beside an explicit principal, and the chained form keeps one entry
  point instead of the curried `forApplication<Principal>()(App)` (#60). A `Surface.application` now takes optional
  `initial`/`update` and accepts resource-carrying Commands.
- **Subset ownership is enforced.** `Agent.forApplication(App).exposeSubset`
  refuses a subset whose owner token belongs to a different application, matching
  `Sync.forApplication`, so two structurally identical applications cannot mix
  selections.
- **One outcome summary for adapters.** `Agent.summarize(dispatchResult)` returns
  `{ ok, text }` — `Dispatched <tag>` without a completion contract, otherwise
  `<Completed|Failed>: <tag>`. WebMCP, MCP, A2A, and Agent Native render it
  instead of repeating the wording four times.

### `foldkit-durable`

- **Compacted operation identity.** Compaction drops the payload but now keeps a
  SHA-256 payload hash, so a retry of a compacted `opId` with different data or
  actor is an `IdentityConflictError` instead of being accepted as an idempotent
  repeat. When the payload is compacted, `append` returns `AlreadyCommitted`
  (`opId`, `sequence`, `actorId`) rather than returning the retransmitted
  operation as the committed one — which could otherwise run an effect for
  content that was never committed. The `user_version` migration to 2 adds and
  backfills the column.
- **Newer databases are refused.** A database whose `user_version` is above this
  build's `SCHEMA_VERSION` fails during `makeJournal` with
  `UnsupportedJournalVersionError` instead of being treated as migrated.
- **Reads below the floor fail closed.** `read(key, after)` fails with
  `CompactedCursorError` when `after < compact_before`, rather than returning a
  tail that silently starts late.
- **Encoded-typed and branded surface.** `Codec<Value, Encoded>` carries the wire
  side, and `append` takes it instead of `unknown`. `Committed` now includes the
  journal's own `opId`, and `sequence`/`cursor` are branded `Sequence`/`Cursor`,
  so `read` and `compact` cannot be swapped.
- **Batch, maintenance, and recovery APIs.** `appendAll` commits an ordered batch
  in one transaction. `keys`, `reset`, `unfinished`, and `clearEffect` give
  recovery and maintenance an API instead of re-deriving intents from
  application state.
- **Canonical idempotency.** Encoded payloads are canonicalized (object keys
  sorted) before they are stored and hashed, so a retry with a different key
  order is the same operation rather than an `IdentityConflictError`.
- **Bounded change stream.** `subscribe` is a sliding `PubSub`: a slow subscriber
  drops the oldest wake-ups instead of growing memory without bound.
- **Multiple journals.** `makeJournalLayer` and `JournalService` take an optional
  service key, so an application with more than one journal type does not
  collide on the default tag.
- **Retry control and Effect authorization.** `runEffect(key, run, { retryFailed:
  false })` fails fast with `EffectFailedError` instead of retrying a failed
  record, and `authorize` may return an `Effect` (it runs inside the append
  transaction, so it has no service requirement).
- **Canonical hash migration.** `SCHEMA_VERSION` 3 recomputes retained
  operations' `payload_hash` from canonical JSON, so a payload compacted after
  the upgrade compares canonically rather than rejecting a reordered retry. A
  payload already compacted before schema 3 keeps its legacy hash.
- **A recovery worker.** `journal.recover({ key, from, intents, onUnresolved })`
  runs the scan/reconcile loop the README described: it replays committed
  operations after `from`, derives their effect intents, reuses recorded
  successes, and stops before an operation whose intent failed or was skipped,
  returning the cursor it settled so the caller can persist it.

### `foldkit-sync`

- **Fragments.** `Sync.forApplication(App).fragment({ shared, durable })`
  declares one feature's shared fields and durable Messages, and
  `compose(...fragments)` merges them into a value to spread into `make`,
  inferring the merged shared shape and Message union. A field declared twice
  with a different codec, a duplicate durable tag, or a fragment from another
  application throws (#63).
- **Authorization on the contract.** `make({ authorize: { Tag: rule } })` takes
  one rule per durable variant, with `message` typed as that variant, `shared`
  as the snapshot, and `principal` fixed by `withPrincipal<P>()`; a key that is
  not a durable tag is a compile error. `journalContract()` now returns a
  `PolicyJournalContract` carrying the compiled `authorize`, so
  `makeJournal({ ...contract })` applies it; an unruled variant is allowed and a
  contract without rules declares none (#63).
- **`Sync.mount`.** Runs a Foldkit application over an open replica with one
  reducer: a durable Message is applied at once through `update` and persisted
  afterwards in a Command; a failed persist reverts it and reports through
  `onPersistenceFailure`; the shared slice is re-installed when an exchange or a
  rejection moves the replica; `dispose` waits for in-flight persists; the
  runtime's union is the application's plus three private variants, so Commands
  from `update` need no re-wrapping. `mounted.model`, `dispatch`, `subscribe`,
  and `observe` are the host an agent binds to, `observe` reporting every
  application Message the runtime applies. `foldkit` becomes a peer dependency. This closes the
  runtime seam (#60, section 5) without an upstream hook; `examples/sync` drops
  its hand-written wrapper.
- **A `Contract` for `Module`.** `Sync.forApplication(App).make` attaches
  `contract`: the replica owns the shared projection's paths and records the
  durable tags, so `Module.validate` catches two replication contracts over the
  same field or Message.
- **Surface-based contract.** The standalone `pick`/`Projection` (#59 spike) is
  gone, superseded by the shared Surface `ModelRef`/`Projection`.
  `Sync.forApplication(App).make({ documentId, shared, durable })` derives the
  shared projection, the durable subset, the initial snapshot, and replay from a
  `Surface.application`, a `Projection.pick`/`Projection.compose` projection, and a
  `MessageSet.make` subset; `make({ ..., replay })` replaces the derived replay
  with a custom reducer over the shared slice. It compiles to the low-level
  `defineSync` and returns a read-only `surface`; `TodoSync.journalContract()`
  derives the durable operation/snapshot codecs, empty snapshot, and reducer.
  Additive — `defineSync` remains the protocol primitive. `Sync.project` is
  removed; `Projection.pick` is the writable projection.
- **One entry point, shaped like Agent's.** `Sync.forApplication(App)` specializes
  the constructors to an application and `.make(config)` produces the
  contract, matching `Agent.forApplication(App).make(config)` (#60). The
  earlier `Sync.forApplication(App, config)` and `Sync.make(App, name, config)`
  forms are gone; `Sync.make`'s explicit `initial` and bare constructor array
  came from the application and a `MessageSet.make` subset anyway. `make`
  refuses a durable subset whose owner token belongs to a different application.
  `MakeOptions` names its config.
- **Derived replay is guarded.** `Sync.forApplication`'s replay refuses a durable
  Message whose `update` returns a Command or changes a Model field outside the
  shared projection, naming the Message and the fields, instead of silently
  dropping the Command or the change. A durable Message is a deterministic,
  state-only transition of the shared projection; an effectful Message stays
  local and emits a durable fact when its Command settles. The Command's effect
  is never run. `examples/sync` drops its hand-written copy of the same guards.
- **`submit` fails closed.** The replica replays a Message before writing it to
  the outbox and fails with `ReplayError` (a new `ReplicaError` member carrying
  the replay's message and cause) when replay throws, for the new Message or
  for a pending one while the projection is rebuilt, so a Message no replica
  could apply is never persisted. The submit-time result seeds the optimistic
  projection, so a read after a submit no longer replays the whole outbox.
- **Replay documented at the definition.** `MakeOptions.replay` states that a
  custom replay is a pure reducer over the shared subset, that only durable
  Messages reach it, that it runs during admission, replay, and optimistic
  projection, and that it is not guarded.
- **An exchange loop.** `Replica.start` exchanges once and then after every
  `submit`, until the replica closes or the fiber is interrupted; a transport
  failure is recorded and retried on the next wake, so the application does not
  have to hand-roll the synchronize loop.
- **Branded positions.** `Sequence` (a committed document position) and
  `LocalSequence` (a replica's own 1-based counter) are brands with `sequence`
  /`localSequence` decoders, so `baseCursor`/`serverSequence`/`cursor` cannot be
  swapped with `localSequence`. `Operation`, `CommittedOperation`, `Checkpoint`,
  `ReplicaState`, `Replica.cursor`, and `ReplicaStatus` use them.
- **Distinct committed type.** Sync's committed operation is `CommittedOperation`,
  so importing it beside `foldkit-durable`'s `Committed` no longer collides.
- **Grouped codec helpers.** `Sync.codec` collects `normalizeOperation`,
  `operationFrom`, `committedFrom`, and `decodeExchange`; they are advanced
  wire/transport helpers, not the application-facing surface.
- **Presence as a Stream.** `Presence.changes` emits the live peers on subscribe
  and whenever the set changes, composing with Effect like the journal's change
  stream; `subscribe` remains for a callback edge.
- **Observable status.** `Replica.statusChanges` emits `ReplicaStatus` on
  subscribe and after every submit and exchange, so a UI can subscribe instead of
  polling `status`; `Replica.close` now wakes `Replica.start` so the loop returns
  rather than waiting for the scope.
- **One subscription for status and shared.** `Replica.changes` emits a
  `ReplicaSnapshot` — the status and the optimistic `shared` value read from one
  replica state — on subscribe and after every submit and exchange.
- **Foreign acknowledgements.** A response that acknowledges an operation the
  replica never sent (for example one submitted while the exchange was in flight)
  is a `ForeignAcknowledgementError` and no longer deletes that pending operation.
  A response that both acknowledges and rejects one id is refused too.
- **Encoded persistence.** The replica state is encoded through the shared codec
  before it is saved, so a transforming `shared` schema (`Schema.NumberFromString`,
  a brand, a date) round-trips instead of failing to reload. `Storage` is now
  opaque, and persisted state ids are branded.
- **Failed open cleanup.** `openReplica` closes its storage on a failed open,
  matching `openLwwClock`, instead of leaking the handle.
- **Presence identity.** `servePresence` stamps the connection's own peer id and
  ignores a client-supplied one, so a peer cannot spoof, move, or remove another.
- **Malformed responses are typed.** A malformed exchange response fails with
  `InvalidExchangeError` (and records `lastError`) instead of becoming an Effect
  defect.
- **Terminal transport after retries.** Once the reconnect schedule is exhausted,
  later exchanges fail immediately with the terminal error rather than queueing
  behind a fiber that is gone.
- **Interrupted exchanges free their slot.** An exchange interrupted before a
  reply no longer counts toward the queue limit; a late reply for it is ignored.

## 0.2.0

`foldkit-sync` 0.2.0 and `foldkit-durable` 0.1.1. The `foldkit-agent` family is
unchanged at 0.1.0, so its versions are not republished.

### `foldkit-sync` 0.2.0

- **Version negotiation.** A persisted replica or clock state from a version this
  build does not understand now fails with `UnsupportedReplicaVersionError` or
  `UnsupportedClockVersionError`, naming the found and supported versions, rather
  than a generic invalid-state error. The stored bytes are left untouched, so the
  state stays recoverable. `openLwwClock`'s error type is now
  `StorageError | UnsupportedClockVersionError`; match the new tag when handling
  an unsupported version.
- **`replica.status`.** A redacted view — pending count, cursor, the last exchange
  failure, and the operations the server refused (most recent first, bounded) —
  enough for a UI to explain and recover without exposing Messages or the Model.
- **O(1) projection reads.** `replica.shared` memoizes its projection against the
  immutable replica state, so repeated reads no longer replay the outbox. Measured:
  a read at a 5,000-operation outbox drops from ~100 ms to ~1 µs.

### `foldkit-durable` 0.1.1

- README only. Documents [retention](./packages/durable/README.md#retention):
  operation identities and effect records are never garbage-collected, so a
  reconnecting replica past the compaction floor is still acknowledged idempotently;
  bounding storage means rotating the journal and refusing retries older than the
  retained window. No code change.

### Not published

The repo also gains a benchmark harness (`pnpm bench`, `pnpm bench:storage`), a
weekly non-gating Bench workflow, and a long-outbox recovery test. These are
root-level tooling and are not part of any published package.

## 0.1.0

The first release.

### Packages

- `foldkit-agent` — the protocol-neutral contract: `context`, `expose`, `define`,
  `resource`, introspection, and the bound `AgentRuntime`.
- `foldkit-agent-webmcp` — the browser adapter over `document.modelContext`.
- `foldkit-agent-mcp` — the external MCP adapter: a transport-free handler, plus
  stdio and Streamable HTTP.
- `foldkit-agent-a2a` — the A2A adapter: an Agent Card and `message/send` as
  tasks.
- `foldkit-durable` — a durable, ordered operation log on
  `effect/unstable/sql`, with migrations, compaction, change streams, a durable
  effect ledger, and metrics.
- `foldkit-sync` — a local-first replica: offline outbox, optimistic projection,
  reconciliation, presence, an Effect `Transport` service, and a reconnecting
  WebSocket transport.

### Notes

- Foldkit `0.158.2` peer-depends on `effect@4.0.0-rc.112`, so these packages
  target Effect 4.
- `foldkit-durable` requires Node 22 for `node:sqlite`.
- The `foldkit-agent-native` prototype under `packages/agent-native` is
  `private` and not published.
