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

- **Reference-based selection.** `Surface.application` generates a reference tree
  (`App.fields`), and `Surface.pick`/`Surface.compose` build writable projections
  from it, so a shared projection is derived from the Model Schema instead of
  declared twice. `Sync.forApplication` and `Agent.forApplication` consume it.
- **Typed Message subsets.** `Surface.messages(app, [constructors])` and
  `Surface.unionMessages(...)` produce a `MessageSubset` with a pure codec, a tag
  set, and an owner token, so two structurally identical applications cannot mix
  selections and a subset cannot leak across applications.
- **Encoded types are preserved.** `ModelRef`/`FieldRef` and `MessageSubset` carry
  an `Encoded` parameter, so a transforming field (`Schema.NumberFromString`)
  keeps its encoded type through `Surface.pick` and the journal snapshot codec
  instead of widening to `unknown`.
- **Transition and resources.** `Surface.application` accepts optional
  `initial`/`update` and resource-carrying Commands; the runnable form is what
  `Agent.forApplication` and `Sync.forApplication` require.

### `foldkit-remote` (private)

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

### `foldkit-remote-server` (private)

- **Live handler.** `RemoteServer.live` and the compiled `FoldkitRemoteLive`
  handler were missing; the server can now stream the client's live requirements.
  Two wire bugs are fixed with it: `LiveRequirement` was missing the resume cursor
  and `LivePatch.cursor` was a string while the client cursor is numeric.
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
  `Style.recipe` is a typed variant selector returning Style data.
- **Advanced Style compiler (started).** `Style.pseudo`/`media`/`supports`/
  `container`/`nest` compile to a deterministic class (FNV-1a of the canonical
  rule text) plus CSS text; `Style.keyframes` and `Style.global` contribute
  class-independent CSS. Declarations are kebab-cased and equal rules share a
  class. `NamedStyle.css`/`globalCss` and `Style.stylesheet` expose the CSS as
  data, so SSR and the browser agree and nothing mutates the DOM. Rules inside
  `Style.whenInput` are rejected (`style:conditional-rules-unsupported`). A real
  rule registry and style extraction are still out of scope.
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

### `foldkit-agent`

- **Surface-based context.** `Agent.context` and `Agent.pick` are removed. The
  `define` `context` option now takes a `foldkit-surface` projection — a read-only
  `Projection` (`Projection.of`/`struct`/`fromReader`) or a writable
  `Surface.pick`/`Surface.compose` — and the runtime reads it with `.read`.
  `Agent.forApplication(App)` infers the Model from a `Surface.application` and
  accepts either projection directly; `Agent.forModel<Model>()` remains when there
  is no application. `Agent.contextSchema` is unchanged.
- **Subset exposure and a curried principal.** `Agent.exposeSubset(subset,
  variants)` exposes only the variants of a `Surface.messages` subset, and
  `Surface.unionMessages` composes disjoint subsets. `Agent.forApplication` infers
  the Model, so a `Principal` is supplied by the curried
  `Agent.forApplication<Principal>()(App)` — TypeScript cannot infer Model beside
  an explicit principal. A `Surface.application` now takes optional
  `initial`/`update` and accepts resource-carrying Commands.

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

### `foldkit-sync`

- **Surface-based contract.** The standalone `pick`/`Projection` (#59 spike) is
  gone, superseded by the shared Surface `ModelRef`/`Projection`.
  `Sync.forApplication(App, { documentId, shared, durable })` derives the shared
  projection, the durable subset, the initial snapshot, and replay from a
  `Surface.application`, a `Surface.pick`/`Surface.compose` projection, and a
  `Surface.messages` subset; `Sync.make(App, name, { documentId, initial, model,
  messages, replay })` takes an explicit projection, constructors, and a custom
  `replay`. Both compile to the low-level `defineSync` and return a read-only
  `surface`; `TodoSync.journalContract()` derives the durable operation/snapshot
  codecs, empty snapshot, and reducer. Additive — `defineSync` remains the
  protocol primitive. `Sync.project` now also carries the projection's dependency
  paths.
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
