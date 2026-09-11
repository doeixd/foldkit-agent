# Revision Plan — Foldkit Plus reorganization around Surface and Remote

**Status:** authoritative plan and handoff. Supersedes
`packages/surface/DESIGN_BRAINSTORM.md`, `packages/surface/BACKBONE.md`, and
`packages/surface/REMOTE.md` wherever they conflict; those remain for provenance.
This document is written to be executable by someone with **no prior context**.

**One-line thesis:**

> Whenever Effect already has a lawful structural primitive, Foldkit Plus enriches
> it with Foldkit semantics rather than replacing it.

**Read order:** §1 (repo facts) → §2 (thesis) → §3 (verified substrate) → §4
(packages) → §5 (invariants) → the subsystem sections you are working on → §13
(edge-case catalog) → §14 (pinned-stack traps) → §15 (phases with acceptance
criteria) → §16 (testing) → §20 (immediate next step).

---

## 1. Repository facts and conventions

Self-contained orientation. Verify anything here before relying on it; things move.

### 1.1 What the repo is

`doeixd/foldkit-plus` — a pnpm workspace of Foldkit/Effect packages plus examples.

```text
packages/
  agent/            foldkit-agent            contract + AgentRuntime
  agent-webmcp/     foldkit-agent-webmcp
  agent-mcp/        foldkit-agent-mcp
  agent-a2a/        foldkit-agent-a2a
  agent-native/     foldkit-agent-native     private prototype
  durable/          foldkit-durable
  sync/             foldkit-sync
  surface/          (design docs only today — new code goes here)
examples/
  todo/  sync/
docs/                 replication.md, benchmarks.md, sync-dx.md
REVISION_PLAN.md      this file
PLAN.md               git-ignored scratch tracker
AGENTS.md             working agreements and a trap list — read it
```

### 1.2 Published state

- Published at `0.1.0`: `foldkit-agent`, `foldkit-agent-webmcp`, `foldkit-agent-mcp`,
  `foldkit-agent-a2a`.
- Published at `0.1.1`: `foldkit-durable`.
- Published at `0.2.0`: `foldkit-sync`.
- Git tag `v0.2.0`; GitHub Release created.
- `foldkit-agent-native` is private.
- npm names are the `foldkit-*` convention; new packages use it too.

### 1.3 Toolchain and commands

- pnpm workspace; `pnpm-workspace.yaml` pins the Node/package-manager versions.
- Build: `tsdown`. Tests: `vitest`. Types: `tsc -b` (project references, one
  `tsconfig.json` per package)`. Format: `prettier`.
- The workspace runtime resolves to Node 22.21.1 via `pnpm exec node --version`.
  `foldkit-durable` needs Node 22 (`node:sqlite`).
- Run the full CI sequence before every commit:

```sh
pnpm format          # writes; run this, never bare prettier
pnpm format:check
pnpm typecheck
pnpm test
pnpm demo            # builds, then runs both example demos
pnpm pack:check      # add when a manifest or build changed
pnpm bench           # sync bench + durable storage script (not a gate)
```

- `pnpm format` covers `**/*.{ts,json,yaml}` only. **Markdown is deliberately
  ignored** — write docs by hand and do not run bare `prettier` on them.
- Tests live in `packages/*/test/**/*.test.ts` and `examples/*/test/**/*.test.ts`
  (see `vitest.config.ts`). A `*.test-d.ts` is **type-checked but not executed**
  (vitest's include is `*.test.ts`), so type tests run under `pnpm typecheck`.
- `vitest.config.ts` aliases every workspace package to its `src/index.ts`, so tests
  never depend on a prior build.

### 1.4 Adding a package (the mechanical recipe)

1. `packages/<name>/package.json` with `"name": "foldkit-<name>"`, `version 0.0.0`,
   `"type": "module"`, `exports` → `./dist/index.mjs` + `./dist/index.d.mts`,
   `files: ["dist","README.md","LICENSE"]`, `scripts: { build: tsdown, typecheck:
   tsc -b }`, `peerDependencies` for `effect`/`foldkit` as appropriate,
   `publishConfig.access: public`.
2. `packages/<name>/tsconfig.json` extending `../../tsconfig.base.json`, with
   `"include": ["src/**/*.ts", "test/**/*.ts", "bench/**/*.ts", "tsdown.config.ts"]`.
3. `packages/<name>/tsdown.config.ts` matching a sibling package.
4. `LICENSE` (MIT, Patrick Glenn).
5. Add the package name to the `resolve.alias` map in `vitest.config.ts` if tests
   import it by name (otherwise import by relative path).
6. Keep it private/`0.0.0` until its phase acceptance holds.

### 1.5 Git / coordination hazards

- A concurrent session has been editing `packages/agent/DESIGN.md` and
  `docs/sync-dx.md` in this same working tree.
- **Never `git add -A`.** Stage only the files you own. A previous `git add -A`
  swept another session's in-progress edit into an unrelated commit.
- Before committing, `git status --short` and re-read the staged diff.
- After committing: re-read the diff, re-run the checks, and fix findings in a
  follow-up commit.
- Do not rewrite published history; do not force-push `main`.

### 1.6 Existing concepts this revision replaces (migration map)

| Today | Where | Becomes |
| --- | --- | --- |
| `Agent.context({ schema, select })` | `packages/agent` | Surface `Projection` |
| `Agent.pick(Model, [keys])` | `packages/agent` | `App.model.key…` ModelRefs |
| `Agent.resource({ schema, read })` | `packages/agent` | `Agent.resource({ projection })` |
| `Projection<Model,Fields>{schema,get,set}` | `packages/sync/src/projection.ts` | Surface `ModelRef` + `Sync.project` |
| `pick(Model, [keys])` | `packages/sync` (added recently) | Superseded by Surface `pick`/`ModelRef` |
| `defineSync({ message, shared, empty, durable, replay })` | `packages/sync` | Kept as the low-level escape hatch; `Sync.define` compiles to it |
| `examples/sync/src/runtime.ts` mount wrapper | example | Generalized under a `Sync.mount`/`Sync.browser` adapter (needs a decision, §10.6) |

---

## 2. Thesis and foundational formulas

Foldkit makes **transitions** and **effects** explicit. It does not make two
relationships explicit, and neither does Effect:

1. **Observation** — what part of the Model may this feature read?
2. **Capability** — what subset of Messages may this feature produce?

Today a view gets `(model: Model, h: HtmlBuilder<Message>)`: the whole Model and
whole Message universe regardless of need. The type system cannot express the
intended boundary.

And the repo already contains three independently invented versions of one idea:

- `foldkit-agent`: `Context<Model, Value> = { schema, select }` + `Agent.pick`.
- `foldkit-sync`: `Projection<Model, Fields> = { schema, get, set }` + `pick`.
- `foldkit-agent` resources: `{ schema, read }`.

That repetition is the signal. Projection becomes a shared primitive; Messages get
referenced through it; each package becomes an interpreter.

```text
ModelRef   = Effect Optic + Schema + Model dependency metadata

Entity     = Schema.Struct + stable entity identity + normalization metadata

Selection  = derived Schema + remote field-requirement metadata

Surface    = Projection + Message constructor references

Remote     = normalized entity store + requirement planner
             + Effect RPC (wire) + Effect persistence (cache snapshots)
```

```text
Effect Optic ──▶ ModelRef ──▶ Projection ──▶ Surface
Effect Schema.Struct ──▶ Entity ──▶ Selection ──▶ Remote Projection
Effect Schema ──▶ Query/Mutation Input+Output / RPC / cache / persistence
Effect RPC ──▶ Remote wire execution
Effect Persistence/KeyValueStore ──▶ Remote cache snapshots (disposable)
```

---

## 3. Verified substrate (effect@4.0.0-rc.112 + foldkit 0.158.2)

Checked against the installed packages, not upstream docs. These are the
load-bearing assumptions.

### 3.1 Effect Optic — present and sufficient

`node_modules/effect/dist/Optic.d.ts`:

- `Optic.id<S>()` then `.key(k)` (always present), `.at(k)` (optional/keyed —
  absent key succeeds with absence), `.tag(t)`, `.optionalKey(k)`, `.pick([...])`,
  `.omit([...])`, `.compose(o)`, `.forEach(f)`, `.check(schema)`, `.refine(...)`,
  `.notUndefined()`.
- Constructors: `makeIso`, `makeLens`, `makePrism`, `fromChecks`.
- Types: `Optional<S,A>` is the base; `Lens` and `Prism` both extend `Optional`;
  `Traversal<S,A> extends Optional<S, ReadonlyArray<A>>`; `Iso` extends both Lens
  and Prism. **Type `ModelRef.optic` as `Optic.Optional<Root, Value>`** or a
  subtype; do not assume `Lens` (`.at` is optional).
- `.at` is the exact semantics `ModelRef.at(key)` needs for keyed collections.

**Important:** Optic is structural TypeScript; it does not know about Schema. The
focus **Schema** must come from the Model Schema's fields. Build the `App.model`
tree by walking `Model.fields` and pairing each `Optic.id<Model>().key(k)` with
`Model.fields[k]`. Do not expect Optic to derive or validate the focus Schema.

### 3.2 Effect infrastructure — present

Top-level: `Request`, `RequestResolver`, `Rpc`, `RpcGroup`, `RpcClient`,
`RpcServer`, `KeyValueStore`, `Persistence`, `PersistedCache`, `PersistedQueue`,
`EventJournal`, `EventLog`.

`effect/unstable/`: `rpc`, `persistence`, `sql`, `eventlog`, `workflow`, `socket`,
`http`, `httpapi`, `cluster`, `ai`, `cli`, `devtools`, `encoding`, `observability`,
`process`, `reactivity`, `schema`, `workers` (plus internal paths).

Relevant module files:

- `effect/unstable/rpc/`: `Rpc`, `RpcClient`, `RpcGroup`, `RpcMessage`,
  `RpcMiddleware`, `RpcSchema`, `RpcSerialization`, `RpcServer`, `RpcTest`,
  `RpcWorker`, `RpcClientError`. `RpcSchema.Stream(elementSchema, errorSchema)`
  exists (a marker for streamed RPC responses).
- `effect/unstable/persistence/`: `KeyValueStore`, `Persistence`, `PersistedCache`,
  `PersistedQueue`, `Persistable`, `RateLimiter`, `Redis`.
  `KeyValueStore` exposes `layerMemory`, `layerFileSystem(directory)`, and an SQL
  layer. `Persistence` exposes `PersistedCache`/`PersistedQueue` factories.
- `RequestResolver`: `make`, `makeGrouped`, `makeWith`, `fromFunction`,
  `fromFunctionBatched`, `fromEffect`, `fromEffectTagged`, `setDelay`,
  `setDelayEffect`, `around`, `never`.

**Correction from the source docs:** there is **no browser IndexedDB
`KeyValueStore` layer in the installed `effect`.** `BrowserKeyValueStore.layerIndexedDb`
from `REMOTE.md` §47 is not available here. Source it from an Effect platform
package (`@effect/platform-browser` or similar) if one exists for this rc, or
author a small IndexedDB `KeyValueStore` layer. Until then, Remote cache
persistence in the browser is an open dependency (§8.9, §17).

### 3.3 Effect Schema — present

- `Schema.toEquivalence(schema)` exists (used for structural equality).
- `Schema.optional`, `Schema.NullOr`, `Schema.NumberFromString` exist.
- `Schema.Struct`, `Struct.Fields`, `Struct.Type<F>`, `Struct.Encoded<F>`,
  `Struct.pick`/`omit` (for runtime values), and `Schema.Struct(fields).mapFields`
  exist. To derive a Selection schema, build `Schema.Struct(pickedFields)` from the
  entity's field schemas; `Struct.pick` operates on values, not schemas.
- `Schema.Record` is a namespace (`Record.Key`, `Record.Type<K,V>`); use
  `Schema.Record(Schema.String, Schema.Never)` for a genuinely empty object — see
  §14.
- Encoded vs decoded types are first-class; that is the mechanism for Entity
  relations.

### 3.4 Foldkit shapes — present

- `Message.CreatedTodo` is a callable `TaggedStruct` with `readonly _tag:
  Schema.tag<'CreatedTodo'>`; each constructor is also a Schema.
- `defineMessageUnion` returns `{ match, guards, isAnyOf, subset }` (plus the
  constructors). **`subset(tags: readonly tag[])` returns `Schema.Union<...>`** —
  use it for a Surface's `Message` schema directly.
- `foldkit/update`: `Return<Model, Message, R> = { readonly model; readonly
  commands?: Commands<Message, R> }`; also `combine`, `withOutMessage`, `Step`,
  `Refreshable`/`refresh` (AsyncData revalidation — unrelated to a sync refresh
  Message).
- `foldkit/runtime`: `makeApplication(config)`; config has `Model`, `update`,
  `view`, `subscriptions?`, `container`, `ports?`, `resources?`, `managedResources?`,
  and `init` (`() => Update.Return`, or `(flags[, url]) => …` in routing variants).
  `run`, `embed`, `hydrate` exist.
- `foldkit/html`: `HtmlBuilder<Message> = MessageUniverse<Message> &
  HtmlElements<Message> & HtmlAttributes<Message> & {...}`; `h.OnClick(message:
  Message, options?)`.
- `foldkit/command`: `define`, `mapEffect`, `mapMessage`, `mapMessages`,
  `Interruptible`.
- `foldkit/subscription`: `make`, `aggregate`, `lift`, `persistent`, `fromEvent`,
  `animationFrame`.
- `foldkit/submodel`: `defineView` and submodel types.
- The `foldkit-agent*` packages already peer on `foldkit`; `foldkit-durable` and
  `foldkit-sync` peer only on `effect`.
- **Consequence:** the revision needs no unreleased Effect feature. Risk is
  inference and `unstable/*` churn, not missing primitives.

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

### 4.2 Responsibilities

| Package | Owns | Depends on |
| --- | --- | --- |
| `foldkit-surface` | `ModelRef`, `Projection`, `Surface`, dependency metadata | `effect`, `foldkit` (peer) |
| `foldkit-remote` | `Entity`, `Selection`, `Query`, `Mutation`, `RemoteData`, normalized store, planner, RPC defs, cache persistence | `foldkit-surface`, `effect` |
| `foldkit-remote-server` | `EntitySource`, `QuerySource`, `MutationSource`, selection authorization, handler compilation | `foldkit-remote`, `effect` |
| `foldkit-agent` | policy: naming, descriptions, availability, authorization, principal, completion, audit, cancellation | `foldkit-surface`, `effect`, `foldkit` (peer) |
| `foldkit-agent-{webmcp,mcp,a2a,native}` | protocol mapping only | `foldkit-agent` only |
| `foldkit-sync` | offline replica, replay, reconciliation, presence; writable Surface interpreter | `foldkit-surface`, `effect` |
| `foldkit-durable` | durable ordering/storage/effect ledger; **independent** | `effect` only |

New npm names: `foldkit-surface`, `foldkit-remote`, `foldkit-remote-server`.

### 4.3 Naming / upstream decision

The source docs sometimes write `@foldkit/surface` / `foldkit/surface`. **Decision:**
build in-repo under the existing `foldkit-*` convention for now; keep
`foldkit-surface` designed so it could be proposed upstream later. Do not block the
revision on an upstream decision. Revisit only after Phase 1 acceptance.

### 4.4 One shared application scope

```ts
export const App = Surface.make({ Model, Message })
```

`Surface.make` is descriptive only (it does not create a Runtime). It provides
`App.Model`, `App.Message`, and `App.model` (the typed root `ModelRef`). Everything
is scoped to it:

```ts
const ProjectPage = Surface.define(App, "ProjectPage", { ... })
const TodoAgent   = Agent.define(App, "TodoAgent", { ... })
const TodoSync    = Sync.define(App, "TodoSync", { ... })
const Data        = Remote.make({ entities: [...], queries: [...], mutations: [...] })
```

---

## 5. Cross-cutting invariants

These hold across every package. A design that violates one is wrong even if it
compiles.

1. **Foldkit remains Foldkit.** Never replace or bypass Model, Message, `update`,
   Command, Submodel, OutMessage.
2. **One owner per datum.** Exactly one authoritative owner:
   - local UI/process state → the Foldkit Model;
   - server-derived disposable entity data → `foldkit-remote`;
   - replicated/offline domain state → `foldkit-sync`.
   Never store the same logical datum in two of these. A Surface may compose all
   three; ownership does not blur.
3. **The Model is the single source of truth.** A Projection is a view, not
   storage. The normalized Remote cache is part of the Model, not beside it.
4. **Messages are facts; Commands are effects.** Do not invent `send.archive(...)`
   or any second action vocabulary. UI → Message → `update` → Command → Effect →
   Message → `update`.
5. **Surface has no Commands** and owns no transitions or effects.
6. **Reference, don't redescribe.** Use `Message.X`, `App.model.x`,
   `Entity.ref(User)`, `Project.Address` — never tag strings or duplicated schemas.
7. **No implicit dependency tracking, ever.** Dependencies are declared by typed
   access, never discovered by executing a callback against a Proxy.
8. **Capability ≠ authorization.** A Message in a Surface or an Agent capability is
   a possibility, not a permission. Remote selection authorization and Agent
   exposure are separate, explicit policy.
9. **Untrusted input crosses a Schema boundary first.** Remote wire payloads, agent
   inputs, and any external value are decoded before anything else; excess
   properties are rejected (`onExcessProperty: 'error'`) and the decoder must agree
   with the advertised JSON Schema.
10. **Determinism.** Replay and `Remote.plan` are pure. Time, ids, and randomness
    enter through Messages/parameters, never read from ambient state.
11. **Effect owns infrastructure.** Transport, serialization, storage backends,
    queues, workflows, SQL lifecycle, KV — Effect's. Foldkit Plus owns semantic data
    modeling and Foldkit integration.
12. **Small core, many interpreters.** Surface stays small; DevTools, SSR, MCP,
    Scene, render optimization, and linting consume descriptors rather than enlarge
    them.
13. **Every guard is mutation-verified, and every constraint has a negative type
    test.** A test that passes against deliberately broken code is worthless.
14. **Failures are typed at the boundary and do not leak internals.** Database,
    filesystem, and transport messages may be kept, but never raw Models, Messages,
    principals, or secrets in errors/spans/logs.
15. **No silent capability/version drift.** A persisted format, wire envelope, or
    exposed schema change requires an explicit version bump and a documented policy
    (see §11/§18 for the existing versioning work).

---

## 6. Surface

### 6.1 ModelRef

```ts
interface ModelRef<Root, Value> {
  readonly Schema: Schema.Schema<Value>      // what lives there
  readonly optic: Optic.Optional<Root, Value> // how to focus (internal)
  readonly dependency: Dependency             // what was focused (metadata)
}
```

Public operations:

```ts
App.model.session.user.name     // typed field access, derived from the Model Schema
ref.at(key)                     // keyed/optional focus; absent => Option
ref.index(i)                    // array index focus
ref.select(projection)          // narrow through a Projection
ModelRef.fromOptic(...)         // low-level extension (< 1% of code)
```

**Invariants**

- `App.model.x.y` **constructs a descriptor**; it reads no application state.
- The access expression *is* the dependency declaration.
- A Proxy may implement the ergonomic tree, but dependency discovery by executing
  user code is forbidden (invariant 7).
- `ModelRef` carries `get`/`set` internally from day one (Sync needs writing).
  Public Projection use is read-only; a ModelRef does not grant mutation authority.
- The focus Schema comes from the Model Schema's fields, not the optic.

**Edge cases**

- Optional fields (`Schema.optional`, `Schema.NullOr`) must produce an optional
  focus, preserving absence (`Option`) rather than inventing `undefined`.
- Deeply nested optional (`Option<Option<A>>`) must not collapse silently.
- `Record`/map fields: `.at(k)` on a non-`string`-keyed record must type-check the
  key exactly; a missing key is absence, not `undefined`.
- Array `.index(i)`: out-of-range is absence, not a throw.
- Untagged structs, unions, transformations, and refinements as a Model root are
  out of scope for v1 (Surface requires a `Schema.Struct` root); nested fields may
  be rich.
- A field named like a ModelRef method (`at`, `select`, `index`, `Schema`, `optic`,
  `dependency`) must not be shadowed by the tree — reserve those names or use a
  symbol/`in` guard.

### 6.2 Projection

```ts
interface Projection<Root, Value> {
  readonly Model: Schema.Schema<Value>
  readonly dependencies: DependencyTree
  readonly read: (root: Root) => Value
}
```

API (v1, deliberately small):

```ts
Projection.of(Schema)({ field: true, nested: OtherProjection })
Projection.struct({ ref, projection, ... })
Projection.array(projection)
Projection.option(projection)
Projection.read(projection, model)           // data-last: Projection.read(projection)(model)
```

**Invariants**

- `Model → Value` alone is insufficient; carry the `DependencyTree`, which is what
  enables masking, DevTools, docs, fixtures, invalidation, MCP descriptions, and
  architectural analysis from one declaration.
- `read` is pure; it never fetches and never mutates.
- The descriptor is a real runtime value, not erased by type-checking.

**Edge cases**

- `Projection.of(Schema)({ doesNotExist: true })` must not compile.
- `Projection.of(Project)({ owner: ProjectSummary })` must not compile when `owner`
  is a `User`.
- Selecting a relation field with `true` (instead of a nested Projection) is a
  design decision: either forbid it or select the whole relation shallowly. Pick one
  and test it.
- Empty selections; duplicate keys across `struct`; two children focusing the same
  path with different shapes (conflict).
- Dependency trees must merge and de-duplicate; order must not affect the result.
- `Projection.option`/`array` over an already-optional/array value must not double
  wrap.
- No `Projection.map` initially — derived display values belong in the view, so a
  Projection stays "data observed from Model", not another derived-state system.

### 6.3 Surface

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

`Surface.read(surface, model, params)` / `Surface.read(surface, params)(model)` is
pure. `Surface.view(surface, (model, h) => …)` infers the projected Model and
narrows the `HtmlBuilder` to the declared Message set. `Surface.registry(App,
[surfaces])` is explicit (no hidden global registry).

**Invariants**

- `Params` optional (conceptually `void`); `messages` optional (read-only Surface,
  `Message = never`).
- `name` is diagnostic only; renaming changes no semantics.
- Messages are constructor **references**, never tags.
- A Surface is an access boundary; a Submodel is an ownership boundary. They are
  complementary, not alternatives.
- Composition rule: `child Model requirement ⊆ parent projected Model` **and**
  `child Message set ⊆ parent Message set`.
- Inside a child view the builder stays narrowed to the child's Messages.

**Edge cases**

- Read-only Surface: an interactive attribute (`h.OnClick`) must not type-check.
- A child view requiring a Message the parent omits must not compose.
- Two Surfaces with the same `name` in a registry; Surfaces from different `App`
  scopes composed together.
- A parameterized Surface used without params; a Surface whose projection is the
  whole Model; a Surface with zero dependencies.
- `Surface.view`'s variance: `h.OnClick(message: Message)` is **contravariant** in
  `Message` (a builder accepting a superset is usable where a subset is expected),
  but `HtmlBuilder<M>` also contains `MessageUniverse<M>`/`HtmlElements<M>` which
  may be covariant. The combined variance is the key Phase 0 risk (§15).
- A child whose projected Model is a strict subset of what the child `model`
  callback reads: the `Surface.define` callback receives the **root** Model and
  returns a Projection, so the callback itself may read anything; the *view* is
  narrowed. Do not confuse the two.

### 6.4 Type-safety acceptance (Surface)

- Invalid Model fields, wrong nested Projections, wrong collection key types,
  Messages outside `App.Message`, and un-granted Messages in a view fail to compile.
- Normal use has no explicit generic arguments and no hand-written interface
  duplicating a Projection.
- Each of the above has an `@ts-expect-error` in a `*.test-d.ts`.

### 6.5 Rejected alternatives (do not reintroduce)

Magic Message tag strings; imperative capabilities (`send.archive`); selector
callbacks with executed-Proxy dependency inference; Surface-owned Commands; a child
registry; a normalized cache inside Surface; inferring allowed Messages from what a
view emits; Surface as a second mutation/action system.

---

## 7. Entity and Selection

### 7.1 Entity

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

**Decision:** the `Schema.Struct` form is canonical. `REMOTE.md` §6's
`Entity.make("User", { id, fields })` is superseded — it reduces Schema, which the
thesis forbids.

Derivations: `User.schema`; `User.fields === User.schema.fields`; `User.id =
User.schema.fields.id`; `User.ref(userId)` requires the right branded ID.

**Invariants**

- Entity roots are `Schema.Struct` with an `id` field. Individual fields may use any
  rich Schema.
- `Entity.make` produces an immutable descriptor; `name` is a persistent
  protocol/cache identity (and therefore part of the wire contract).
- `Entity.ref(Entity)` is **both a Schema and normalization metadata**.

**Edge cases**

- `Entity.make` with no `id` field, a non-Struct root, a union root, or a
  transformed root.
- An entity whose `id` schema is `Schema.String` (unbranded) vs branded; two
  entities with the same `name`.
- Recursive relations (`User.manager: Entity.ref(User)`, or a cycle
  `Project.owner → User → favouriteProject → Project`): encoding recursion must
  terminate. **Prototype before relying on it.**
- Self-reference during definition (referring to the entity before it exists) — note
  whether `Entity.ref` needs to be lazy.
- An entity with zero relations; an entity whose only field is `id`.
- Optional/`NullOr` relation fields.
- Two structurally identical entities with different `name`s (must still be
  distinguished by `name`).

### 7.2 Relations

**Decision:** a relation is an `Entity.ref` Schema with distinct decoded and encoded
forms:

```text
decoded (application): owner: User
encoded (normalized):  owner: EntityRef<User>   // "User:u7"
```

This reuses Effect Schema's encoded/decoded distinction instead of a parallel
relation codec. Option B from the brainstorm (`owner: User` for selections/Sources);
the store keeps the reference form internally.

**Edge cases**

- Encoding a relation with no loaded target (a dangling reference must remain a
  valid reference, not become `undefined`).
- Round-tripping a relation through `Schema.encode`/`decode`.
- A relation that is `null` (explicitly no owner) vs absent.
- Partial selections that include the relation but not its fields.
- A recursive relation's Schema construction (same as above).

### 7.3 Selection

```ts
const UserSummary = Selection.make(User, { id: true, name: true, avatarUrl: true })
const ProjectSummary = Selection.make(Project, {
  id: true, name: true, status: true, owner: UserSummary,
})
```

- `UserSummary.schema` exists at runtime and is equivalent to
  `Schema.Struct({ id: UserId, name: Schema.String, avatarUrl: Schema.String })`.
- Keys are checked against the referenced Schema.
- Nested Selections compose recursively and retain requirement metadata.
- `Selection.union(a, b)` merges compatible fields (data-first and pipeable).

**Invariants**

- The derived Schema is the single source for type, runtime validation, RPC codec,
  MCP/JSON Schema, cache validation, SSR serialization, and fixtures.
- Selection metadata is a **requirement AST**, not a cache and not a transport.

**Edge cases**

- Selecting only relations (no scalars); selecting only the `id`; an empty selection.
- Selecting a relation with `true` vs a nested Selection (decide and test).
- Unions with overlapping scalar fields (merge), overlapping relations with
  different sub-selections (merge allowed?), and contradictory selections (reject).
- Selecting a field whose Schema is optional/`NullOr`/transformed/branded.
- Selection identity/caching: two textually different Selections with equal field
  sets should be equal (or at least canonicalizable).

### 7.4 Patches

```ts
Entity.patch(Project.ref(id), { name: "Foo" })   // ok
Entity.patch(Project.ref(id), { banana: 1 })     // must not compile
Entity.patch(Project.ref(id), { status: 123 })   // must not compile
```

The patch schema derives from the entity struct. No secondary field type system.
Edge cases: patching `id`; patching a relation; an empty patch; patching an
optional field to absent vs `null`.

---

## 8. Remote

`foldkit-remote` provides what neither Foldkit nor Effect provides: normalized
application-facing server state. Everything below the semantic layer is Effect.

### 8.1 Definition and binding

```ts
const Data = Remote.make({
  entities: [User, Project],
  queries: [ProjectsByOwner],
  mutations: [RenameProject],
})
// Data.Model, Data.Message, Data.update, Data.initial, Data.rpc, Data.registry

const Model = Schema.Struct({ route: Route, session: Session, remote: Data.Model })
const App = Surface.make({ Model, Message })
const AppRemote = pipe(Data, Remote.at(App.model.remote))
```

### 8.2 Store as a Foldkit Submodel

```ts
interface RemoteModel {
  entities: EntityStore      // values + presence (+ tombstones)
  queries: QueryStore        // connection order + cursors (references, not copies)
  requests: RequestState
  mutations: MutationState
  optimistic: OptimisticLayers
}
```

**Invariants**

- The cache is part of the Model; there is no hidden mutable cache.
- Cache updates happen only through Remote Messages processed by `Remote.update`.
  Network code never mutates the store directly, so DevTools/time-travel see cache
  evolution.
- The remote Submodel owns its internal Messages; the app Message union wraps them
  (e.g. `GotRemoteMessage({ message })`) rather than being polluted with
  `StartedRequest`, `ReceivedBatch`, etc.

**Edge cases**

- Concurrent requests for the same field (dedupe/in-flight reuse).
- A response arriving after the requesting component is gone (store it anyway or
  drop it — define the policy; do not leak into UI).
- Out-of-order/overlapping batches writing the same field (last-writer policy vs
  merge; define it).
- Entity deleted server-side (tombstone) then recreated (clear tombstone).
- Restoring a persisted cache whose entity set/version changed (clear + refetch).

### 8.3 Field presence and tombstones

```ts
interface EntityEntry {
  readonly values: Record<FieldId, unknown>
  readonly present: FieldSet
}
```

**Invariants**

- Presence is tracked separately from values.
- The store distinguishes: missing, present `undefined`, present `null`, stale,
  not-found.
- Presence cannot be inferred from `value === undefined`.
- Tombstones make absence cacheable so a missing entity is not refetched forever.
  They clear on invalidation, live creation, cache reset, or an explicit mutation
  result.

**Edge cases**

- A field that is legitimately `undefined` vs unfetched.
- A field that is `null` (explicitly empty) vs missing.
- Stale-but-present (revalidation policy).
- Tombstone + a later `Entity.patch` for the same id.
- Relation to a not-found entity (reference remains; the target is a tombstone).

### 8.4 RemoteData

**Decision — one unambiguous representation:**

```ts
type RemoteData<A> =
  | { readonly _tag: "Initial" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready";      readonly value: A }
  | { readonly _tag: "Refreshing"; readonly value: A }                         // always carries the last value
  | { readonly _tag: "Failed";     readonly error: RemoteError; readonly previous?: A }
  | { readonly _tag: "NotFound" }
```

`RemoteData.match(...)` is exhaustive. No Suspense-like hidden control flow;
loading/error/data are visible application states.

**Edge cases**

- `Ready → Refreshing → Ready` on revalidation; `Ready → Refreshing → Failed` keeps
  `previous`.
- `Initial` vs `Loading` (has a request started?).
- `NotFound` vs `Failed`.
- An optional/absent entity (`Option<RemoteData<A>>` vs `RemoteData<Option<A>>`) —
  pick one and document it. Recommended: `RemoteData<Option<A>>` when the key itself
  may be absent, else `RemoteData<A>`.

### 8.5 Requirements and the planner

A Remote Projection produces a pure immutable requirement tree; `Remote.plan`
diffs it against the cache and returns the minimal missing/stale selections.

**Invariants**

- Planning is deterministic: same `RemoteModel` + requirements + freshness + `now`
  ⇒ same plan. `now` is injected (Effect `Clock` outside); never call `Date.now()`.
- The plan contains **missing fields only**, never whole entities or the whole
  Surface.
- Requirements are plain data: combinable, inspectable, serializable, diffable,
  DevTools-visible.

**Edge cases**

- Cyclic requirements (`Project.owner → User → favouriteProject → Project`) — depth
  bound or visited-set; define the semantics.
- A requirement on an entity already tombstoned.
- Two requirements overlapping with different freshness policies.
- A relation whose target id is present but the target entity is missing.
- Freshness/TTL and clock skew.
- Planning with no cache (everything missing) and with a fully satisfied cache
  (empty plan).

### 8.6 Wire — Effect RPC, not a Remote transport

**Decision:** Remote defines RPC semantics; Effect RPC transports them. No
`RemoteTransport`, no `foldkit-remote-{http,ws,indexeddb,sql}` packages.

```ts
const Read   = Rpc.make("FoldkitRemoteRead",   { payload: ReadBatch,      success: ReadBatchResult, error: RemoteReadError })
const Mutate = Rpc.make("FoldkitRemoteMutate", { payload: MutationRequest, success: MutationResult,  error: RemoteMutationError })
const Live   = Rpc.make("FoldkitRemoteLive",   { payload: LiveRequirement, success: RpcSchema.Stream(LivePatch, RemoteLiveError), error: RemoteLiveError })
const RemoteRpc = RpcGroup.make(Read, Mutate, Live)
```

Verify exact syntax against rc.112.

**Invariants**

- Batching is semantic (`ReadBatch` built by Remote), not transport-dependent.
- Reads may dedupe/union/batch. **Mutations preserve order and are never merged or
  auto-batched** (a future explicit transaction abstraction may batch them).
- Live data is effect streaming RPC merged into the same store via Messages.
- Application transport is chosen directly from Effect (`RpcClient.layerProtocolHttp`,
  `layerProtocolSocket`, …).
- A test fake must be built from the protocol spec, not from the implementation.

**Edge cases**

- Server returns references to entities not included in the batch (dangling refs →
  treat as missing and fetch).
- Unknown/newer protocol fields (strict decode vs tolerate; define version
  negotiation).
- Partial success (some entities found, some missing) — `NotFound` tombstones.
- Mutation retried by the transport (idempotency; mutations are not deduped).
- Large batches (`maxQueue`/backpressure is a transport concern; Remote must not
  assume one batch fits).
- Live patch for an entity not in the cache (upsert), and a live patch racing a
  read response (ordering/merge).

### 8.7 Observation

`Surface.read` stays pure. Fetching is a Foldkit Subscription:

```ts
const subscriptions = (model: Model) => [
  Remote.observe(AppRemote, ProjectPage, { projectId: model.route.projectId }),
]
```

`Remote.observe` extracts requirements, diffs against `model.remote`, and produces a
Subscription for the missing data. `Remote.observeProjection(AppRemote, projection)`
is the lower-level form (Projection is the real dependency description).
`Remote.prefetch(...)` reuses the same plan for SSR/route/hover/agent/tests.

**Edge cases**: observation removed before the request lands; the same projection
observed by two Surfaces; a projection whose params change every render (key
stability); observe during SSR with no transport.

### 8.8 Mutations and optimistic layers

UI → Message → `update` → Command → `Remote.mutate` → Effect RPC → Message →
`update`. A mutation response carries a typed `Output` plus cache patches:

```ts
{ output: { projectId }, entities: [Project.patch(projectId, { name })] }
```

Optimistic updates use layers, not inverse patches:

```text
base cache + optimistic layer #1 + #2 = visible cache
success → merge server patch, remove the layer
failure → remove the layer, revealing the base
```

**Edge cases**

- Two optimistic layers patching the same field concurrently (apply order).
- Success patch conflicts with a later optimistic layer.
- Failure after the server did commit (the visible state must reconcile with the
  next server truth).
- Mutating an entity that is not cached; mutating a relation; optimistic delete
  (tombstone) vs failure.
- Do **not** build optimistic updates until ordinary mutation reconciliation is
  solid.

### 8.9 Persistence

Delegate to Effect `KeyValueStore`/`Persistence`; no Remote storage abstraction.
`RemotePersistence.save(Data, remoteModel, { key })` /
`RemotePersistence.restore(Data, { key })`.

Remote data is server-derived and disposable: incompatible cache → fail decode →
clear → refetch. Do **not** copy Sync's preserve-and-recover policy. `PersistedCache`
is `Request → Result`, a different cache from `Entity + Field → Value`.

**Open dependency:** the browser IndexedDB `KeyValueStore` layer is not in the
installed `effect`; source it from an Effect platform package or author it.

**Edge cases**: cache version mismatch; partial/corrupt snapshot; quota exceeded;
two tabs persisting concurrently; restoring a cache whose entity Schemas changed.

### 8.10 Server: `foldkit-remote-server`

Owns entity/query/mutation Sources, selection authorization, normalization, result
construction, handler compilation. Does not own HTTP, WebSocket, serialization, auth
protocol, or DB connections.

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
// RemoteServer.handlers(Server) → provide to Effect RPC
```

**Invariants**

- Runtime dependencies stay in the Effect environment (never capture a `db`).
- **Selection authorization is mandatory and separate from authentication.**
  Authentication answers "who is this?" (Effect RPC middleware → `Principal`).
  Remote authorization answers "may this principal read this semantic
  field/entity?" A client must not request `passwordHash` and have a Source honor it
  blindly.
- Durable work uses Effect `PersistedQueue`/`Workflow`; Remote may depend on
  `foldkit-durable` only through ordinary Source dependencies.

**Edge cases**

- Field-level denial: omit the field, or fail the whole selection? Define it, and do
  not leak existence of an unauthorized entity/field.
- An entity that exists but the principal may not see (NotFound vs Unauthorized).
- A Source returning a partial entity (missing fields) — presence must reflect that.
- A Source returning a dangling relation.
- N+1 selections across a relation.
- Mutations that partially succeed (define transactional expectations).
- Selection that no Source can answer (empty result vs error).

### 8.11 Errors, spans, introspection

- Tagged errors only where Remote adds meaning: `RemoteSelectionError`,
  `RemoteDecodeError`, `RemoteProtocolError`, `RemoteNotFoundError`,
  `RemoteUnauthorizedError`, `RemoteMutationError`, `RemoteVersionError`.
  Transport failures stay Effect RPC/client errors.
- Spans: `FoldkitRemote.{plan,read,mutate,live,prefetch}` with name/field counts/
  cache hits/misses/batch size; never attach sensitive values.
- Pure introspection: `Remote.inspect`, `Remote.inspectEntity`,
  `Remote.inspectQuery`, `Remote.plan`; DevTools must not reach into private layouts.

---

## 9. Agent

Agent keeps all policy (naming, descriptions, external input mapping, availability,
authorization, principal, completion, audit, cancellation). Surface only supplies
the Model projection and Message subset.

```ts
const AppAgent = Agent.define(App, "TodoAgent", {
  model: ({ model }) =>
    Projection.struct({ todos: model.todos, selectedTodoId: model.selectedTodoId }),
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

**Invariants**

- Agent is an externalization **interpreter of a Surface**, not a competing
  abstraction.
- Higher-level builders create a Surface internally and expose `.surface`;
  `Agent.fromSurface(...)` is the escape hatch.
- Protocol adapters (`webmcp`/`mcp`/`a2a`/`native`) consume the compiled Agent, not
  Surface/ModelRefs, and change very little.
- Exposure is separate from capability: `Mcp.exposeSurfaces(Surfaces, { allow })`;
  DevTools may inspect everything in development.

**Edge cases**

- `available` reads only the Surface's projected Model (which may be a subset of
  what the callback wants) — the type must constrain it.
- A capability whose `input` cannot be derived from the Message payload (external
  input mapping is Agent policy, not Surface).
- Authorization refusal vs unavailability (must not leak which).
- Completion correlation for an invocation that was never subscribed (refused
  before subscribe).
- A capability that resolves a Remote-backed projection that is not loaded
  (`RemoteData` visible vs an effectful resolution — defer).

---

## 10. Sync

Sync keeps the offline replica, replay, reconciliation, and presence. It stops
hand-rolling a projection.

```ts
const TodoSync = Sync.define(App, "Todos", {
  documentId: documentId("todos"),
  model: Sync.project({ todos: App.model.todos }),  // writable projection from ModelRefs
  messages: [Message.CreatedTodo, Message.RenamedTodo, Message.DeletedTodo],
  replay: updateShared,
})
// TodoSync.surface : observes/writes Model.todos, accepts those Messages
```

### 10.1 Invariants

- `Sync.project({...})` is a **writable** projection derived from `ModelRef`s
  (`ModelRef` carries `get`/`set` internally). Surface projections stay read-only
  publicly; only Sync regains write authority.
- `replay` is inferred against the declared Message subset, not the whole union.
- The low-level `defineSync({ message, shared, empty, durable, replay })` remains the
  protocol primitive and escape hatch; `Sync.define` compiles down to it.
- `foldkit-durable` stays independent; Sync produces the replay contract via
  `Sync.journalContract(TodoSync)` → `{ operation:{encode,decode},
  snapshot:{encode,decode}, empty, reduce }`.

### 10.2 Edge cases (carry forward from the current implementation — these are hard-won)

- **Compacted operation identity**: a resumed/compacted op reused with different
  data or actor must conflict, and must never return a fabricated `Committed`
  operation. (Already implemented in `packages/durable`: payload hash + `AlreadyCommitted`.)
- **Foreign acknowledgements**: a server ack for an operation that was not sent
  (e.g. submitted mid-exchange) must not delete local work. (Already implemented.)
- **Encoded vs decoded persistence**: the replica state is encoded before saving, so
  a transforming `shared` codec round-trips. (Already implemented.)
- Checkpoint adoption + pending rebase; a checkpoint behind the cursor is refused.
- Presence identity is server-owned; presence is partitioned by document.
- Storage eviction, stale writers (CAS), malformed persisted data, unsupported
  versions.
- The runtime-mount ordering: persist before the shared Model is installed.

### 10.3 Durable

Unchanged semantics: ordered Message log, authoritative replay, snapshot + cursor,
Message idempotency, effect ledger. Must not depend on Surface for neatness.
Review later whether internals should reuse Effect
`EventJournal`/`EventLog`/`PersistedQueue`/`Workflow` where that preserves
Foldkit-specific semantics. No `foldkit-remote-durable` package.

---

## 11. Canonical end-to-end example (target)

The Todo app is the smallest thing that exercises every package. Keep a compiling
version of this as the integration target.

```ts
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Surface, Projection } from "foldkit-surface"
import { Agent } from "foldkit-agent"
import { Sync } from "foldkit-sync"
import { Entity, Selection, Remote, RemoteServer } from "foldkit-remote"

const TodoSchema = Schema.Struct({ id: TodoId, title: Schema.String })
const Todo = Entity.make("Todo", TodoSchema)

const Model = Schema.Struct({ todos: Schema.Array(TodoSchema), selectedTodoId: Schema.NullOr(TodoId) })
const Message = defineMessageUnion({
  CreatedTodo: { id: TodoId, title: Schema.String },
  RenamedTodo: { id: TodoId, title: Schema.String },
  SelectedTodo: { id: TodoId },
})

const App = Surface.make({ Model, Message })

const TodoList = Surface.define(App, "TodoList", {
  model: ({ model }) => Projection.struct({ todos: model.todos, selection: model.selectedTodoId }),
  messages: [Message.CreatedTodo, Message.RenamedTodo],
})

const TodoAgent = Agent.define(App, "TodoAgent", {
  model: ({ model }) => Projection.struct({ todos: model.todos }),
  capabilities: [Agent.capability(Message.CreatedTodo, { description: "Create a todo" })],
})

const TodoSync = Sync.define(App, "TodoSync", {
  documentId: documentId("todos"),
  model: Sync.project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo, Message.RenamedTodo],
  replay: updateShared,
})

const journal = yield* makeJournal({
  ...Sync.journalContract(TodoSync), file, opId, actorId, authorize,
})
```

(Types like `TodoId`/`documentId`/`updateShared`/`makeJournal` are illustrative.)

---

## 12. Decision log

| Topic | Decision | Reason |
| --- | --- | --- |
| `Entity.make` shape | `Entity.make(name, Schema.Struct({...}))` | Brainstorm supersedes `REMOTE.md` §6; never reduce Schema. |
| Entity field namespace | `User.fields === User.schema.fields` | No second namespace. |
| Entity root constraint | `Schema.Struct` with an `id` field | Buys field lookup, partial selection, patch schema, ID extraction, inference. |
| Relations | `Entity.ref` as a Schema with distinct decoded/encoded forms | Reuses Schema's codec boundary; no parallel relation codec. |
| `ModelRef` read/write | Internal `get`/`set`; public Projection read-only | Sync needs writing without granting UI mutation authority. |
| Dependencies | Declared by typed access; never Proxy-executed selectors | Invariant 7. |
| Optic type | Base on `Optic.Optional<Root,Value>` | `.at` is optional; Lens/Prism extend Optional. |
| `RemoteData` | Tagged union; `Refreshing`/`Failed` carry the last value | Removes "may retain" ambiguity; exhaustive match. |
| Remote cache | Foldkit Submodel in the app Model | Cache in DevTools/time travel; no hidden cache. |
| Field presence | Separate `values` + `present`; tombstones | `undefined`/`null`/absent/unfetched distinct. |
| Wire | Effect RPC; no `RemoteTransport` | Remote owns semantics, Effect owns transport. |
| Mutations | Via Commands; typed Output + cache patches | Preserve the Foldkit transition system. |
| Persistence | Effect `KeyValueStore`; Remote cache disposable | Server-derived data; clear+refetch. |
| Browser KV | **Open**: not in installed `effect` | Source from a platform package or author it. |
| Planner | Pure, deterministic, `now` injected | Testable, DevTools-visible. |
| Agent exposure | Separate opt-in | Capability ≠ authorization. |
| Message subsets | `Message.subset(tags)` → `Schema.Union` | Foldkit already provides it. |
| Package names | `foldkit-surface`/`foldkit-remote`/`foldkit-remote-server`, Surface upstreamable | Repo convention; no upstream block. |
| Durable | Independent; Sync provides the journal contract | Owns ordering/storage, not semantics. |
| Low-level Sync | `defineSync` retained | Escape hatch for non-Foldkit/unusual consumers. |

---

## 13. Edge-case catalog (consolidated)

Use this as a checklist when designing tests. Cross-reference the per-section lists.

**Surface / projection**
- Missing/undefined/null/optional fields; nested Option; absent record key; array
  out-of-range; non-string record keys; field names colliding with ModelRef methods.
- Selecting a relation with `true` vs a nested projection; duplicate keys; two
  children on one path; empty projection; dependency-tree merge order.
- Parent/child Message subset mismatch; read-only Surface with an interactive attr;
  duplicate Surface names; cross-`App` composition.

**Entity / relation / selection**
- No `id`; non-Struct/union/transformed root; unbranded id; duplicate names; zero
  relations; recursive/self-referential relations; optional/null relations; dangling
  references; encode/decode round-trip; partial relation selections; selection
  unions with overlapping relations; empty selection; transformed fields.

**Remote store / presence / planner**
- Concurrent same-field requests; late responses; out-of-order/overlapping batches;
  delete-then-recreate; restore with a changed schema/version; present-undefined vs
  missing vs null vs stale vs not-found; tombstones + later patches; relation to a
  not-found entity; cyclic requirements; overlap with different freshness; target id
  present but entity missing; no-cache and fully-satisfied plans; TTL/clock skew.

**RemoteData**
- Initial vs Loading; Ready→Refreshing→Ready; Ready→Refreshing→Failed (keeps
  previous); NotFound vs Failed; optional key (`RemoteData<Option<A>>`).

**Wire / server**
- Dangling refs in a batch; unknown/newer fields; partial success; retried
  mutations; large batches/backpressure; live patch for an uncached entity; live vs
  read race; field-level authorization denial; exists-but-hidden; partial entity;
  N+1 relations; partially-succeeding mutations; unanswerable selection.

**Sync / durable** (mostly already implemented and tested)
- Compacted identity reuse; foreign ack/reject; encoded persistence; checkpoint
  rebase; checkpoint regression; presence spoofing/document scope; stale writer CAS;
  eviction; malformed persisted state; unsupported versions; unfinished migration.

**Agent**
- `available` reading outside the projected subset; external-input mapping; refusal
  vs unavailability (no leak); completion for an unsubscribed invocation; a
  Remote-backed context that is not loaded.

**SSR / persistence**
- In-process RPC; cache serialization/versioning; hydration mismatch; quota/blocks;
  two-tab concurrency.

---

## 14. Pinned-stack traps and tips

Effect `4.0.0-rc.112` differs from v3 and from older rc notes. Check the installed
`.d.ts` before using a remembered API, and run the scratch probe from the package
directory (a probe from the repo root may resolve a different `effect`).

**Effect 4 renames / gaps**

- `Effect.either` → `Effect.result`; `Effect.async` → `Effect.callback`;
  `Effect.timeoutFail` → `Effect.timeoutOrElse`; `Duration.decodeUnknown` →
  `Duration.fromInputUnsafe`; `Schema.OptionFromSelf` → `Schema.Option`.
- `Effect.makeSemaphore` is absent — `SynchronizedRef.modifyEffect` is the
  serialization idiom.
- No `Effect.zipRight`; `Deferred.makeUnsafe`; `Effect.forkScoped` (no `Effect.fork`).
- `Metric.update`/`Metric.value` (no `Metric.increment`).
- `Fiber.poll` is absent in this rc (`fiber.pollUnsafe()` is the instance hook);
  restructure rather than reach for it.
- `Effect.callback`'s register may return an `Effect` cleanup that runs on
  interruption — the correct hook for releasing queue/connection slots.
- `Effect.result` captures typed failures, **not defects**. A guard that must not
  throw needs `Effect.try`/`catchCause`.
- `Effect.result` yields a `Result` with `_id: 'Result'`; in tests use
  `toMatchObject`, not `toEqual`, when matching a `Result`.
- `Clock` is a `Context.Reference`; `provide` does not narrow it out of a
  `Clock | Scope` requirement. `TestClock` is in `effect/testing`; install
  `TestClock.layer()` before reading, or the "test clock" reads the live clock.

**Effect Schema**

- `Schema.Struct({})` is **not** an empty-object schema: it accepts `{foo:1}`, `[]`,
  and `"str"` even with `onExcessProperty: 'error'`. Use
  `Schema.Record(Schema.String, Schema.Never)`.
- Deriving a Selection schema: build `Schema.Struct(pickedFields)` from the entity's
  field schemas. `Struct.pick` operates on runtime values, not on schemas;
  `Schema.Struct(...).mapFields` maps field schemas.
- Service generics are easy to trip: a generic `Fields extends Schema.Struct.Fields`
  makes `Schema.Struct<Pick<...>>`'s service types untrackable against
  `Schema.Codec<A,E,never,never>`. Prefer concrete `Schema.Struct<Fields>` types and
  cast rarely (see the `pick` spike in git history).
- Encoding validates the decoded side; decoding validates the encoded side. Choose
  which side an internal validator needs — for a decoded state, encode (or validate
  the decoded side), do not decode it as wire data.
- Keep intermediate validators strict too: pass
  `{ onExcessProperty: 'error' }`; a boundary that advertises
  `additionalProperties: false` must reject excess properties in the decoder.

**TypeScript / tooling**

- `exactOptionalPropertyTypes` is on: you cannot assign `undefined` to an optional
  property. Use conditional spread (`...(x === undefined ? {} : { x })`) or an
  explicit `null` union.
- `noUncheckedIndexedAccess` is on: indexed reads are `T | undefined`.
- `@ts-expect-error` is anchored to the **next line**. Reformatting can silently
  detach it; after `pnpm format`, re-run `pnpm typecheck` and confirm it still
  errors. An unused directive is an error (`TS2578`).
- To prove a type constraint, add a `@ts-expect-error` negative. A suite of
  positive cases proves nothing.
- A mutation that survives usually means redundancy, not missing coverage; remove
  the redundant guard rather than testing a window that does not exist.
- Vite 5 does not know `node:sqlite` as a builtin and rewrites a static import to
  `sqlite`; in a Vitest test use `createRequire(import.meta.url)('node:sqlite')`
  with a `typeof import('node:sqlite')` annotation.

**Foldkit**

- Message constructors carry `_tag` and are callable Schemas; `subset`/`guards`/
  `isAnyOf`/`match` are available.
- `HtmlBuilder<M>`'s `OnClick(message: M)` is contravariant in `M`; the rest of the
  builder may be covariant. This mixed variance is the `Surface.view` risk.
- `Refreshable`/`refresh` is AsyncData revalidation, not a shared-state refresh;
  do not reuse it for sync.

**Process**

- Build test fakes from the **spec**, not from your implementation; a fake authored
  from the same assumption tests nothing.
- After every commit, re-read the diff, re-run the four checks, fix in a follow-up.
- Prefer deleting code to adding it; no dead abstraction, unused exports, or
  comments that restate the code.
- Never `git add -A` in this tree (§1.5).

---

## 15. Execution phases with acceptance criteria

Ordering principle: prove inference before architecture; prove pure semantics
before networking; keep each phase independently reversible. Do not start a phase
until the previous phase's acceptance holds.

### Phase 0 — Inference spike (gate)

Build a scratch module plus `*.test-d.ts` proving:

1. `App.model.session.user.name` yields a `ModelRef<Model, string>` with the right
   optic and dependency path; `.at(key)` is optional; `.index(i)` works.
2. `Projection.of(Schema)({...})` checks nested projections and rejects bad keys;
   `Projection.struct(...)` infers the combined value and unions dependencies.
3. `Surface.define`/`Surface.view` narrow the projected Model and the
   `HtmlBuilder` Message set; a child view composes into a parent whose Message set
   is a superset; an undeclared Message does not compile.
4. `Remote.make({entities}).Model` embeds as a Submodel without widening to `any`;
   `Remote.select` yields `RemoteData<...>`.
5. `Selection.make` derives a runtime Schema; `Entity.patch` rejects unknown/wrong
   fields.

**Acceptance:** every case infers with no explicit generic arguments and no `as`;
each rejection has an `@ts-expect-error` that fails `tsc` when removed; `pnpm
typecheck` and `pnpm test` pass. Record results in a "Phase 0 results" section here.
**If a case cannot be made ergonomic, stop and amend this document** with the
architecture change it implies before writing production code.

### Phase 1 — `foldkit-surface` core

`ModelRef` tree; `Projection.{of,struct,array,option,read}`; `Surface.{make,define,
read,view,registry}`. No Runtime changes, no optimization, no MCP.

**Acceptance:** the canonical `TodoList` example compiles with no generics/casts;
the Surface type-safety list (§6.4) is pinned by `@ts-expect-error`; a `Surface.view`
test proves an undeclared Message fails; runtime tests for read/projection/dependency
merge pass; every guard mutation-verified.

### Phase 2 — Composition proof

Surface-in-Surface, Submodel + Surface, parameterized Surfaces, Option/Record/Array
projections, parent Message supersets. Validate against real Foldkit examples
(Kanban, auth, cart, typing game).

**Acceptance:** at least two non-toy Foldkit examples use Surfaces without editing
library internals; child/parent composition type-checks and the negative cases fail;
no regressions in existing packages.

### Phase 3 — Pure Remote core

`Entity`, `EntityRef`, `Selection`, `RemoteData`, normalized `EntityStore`, field
presence, tombstones, `Requirement`, `Remote.plan`, `Remote.merge`. **No network, no
RPC, no database.**

**Acceptance:** `Remote.plan` is deterministic (property test over generated
models/requirements/freshness/`now`); presence states are distinguished by tests;
tombstones prevent refetch and clear correctly; `RemoteData` transitions are
exhaustively matched; recursive relations either work or are explicitly rejected
with a typed error.

### Phase 4 — Remote↔Surface integration

`Remote.make`, `Remote.at`, `Remote.select`, remote Projection nodes, Surface
requirement extraction.

**Acceptance:** a mixed local+remote Surface extracts the right requirement tree;
`Remote.observe` produces a Subscription that fetches exactly the missing fields;
no fetch happens during `Surface.read`.

### Phase 5 — Queries and connections

`Query.make`, `QueryRef`, connections, pagination, query cache, connection
normalization. Still no transport.

**Acceptance:** connection identity is the encoded input + window; an entity update
propagates to every connection containing it; overlapping windows dedupe; cursor
state round-trips; no string cache keys exist in application code.

### Phase 6 — Effect RPC wire

Remote RPC group (`Read`/`Mutate`/`Live`) using `effect/unstable/rpc`.

**Acceptance:** exact rc.112 syntax verified in a scratch file; reads batch/dedupe;
mutations preserve order and are not merged; a protocol-level test uses `RpcTest` or
an in-process layer built from the spec.

### Phase 7 — `foldkit-remote-server`

Entity/Query/Mutation Sources, selection authorization, handler compilation,
normalization, `RemoteServer.make`/`handlers`.

**Acceptance:** field-level authorization is enforced and tested (requesting a
forbidden field fails or omits, without leaking existence); a Source returning a
partial entity yields correct presence; a mutation returns typed Output + cache
patches; handlers run against an in-process RPC layer.

### Phase 8 — Observation

`Remote.observe`, `Remote.observeProjection`, `Remote.prefetch`.

**Acceptance:** SSR prefetch populates the Model; a route change observes the new
Surface and releases the old; no I/O during render.

### Phase 9 — Mutations

`Mutation.make`, `Remote.mutate`, mutation status, cache patches, typed Output.

**Acceptance:** a mutation result reconciles the store through Messages; transport
retries do not duplicate a mutation's application (idempotency policy explicit);
DevTools shows the cache mutation.

### Phase 10 — Optimistic layers

`Entity.patch`, optimistic layers, settle success/failure, overlapping-rebase proof.

**Acceptance:** overlapping optimistic patches rebase correctly on success; a
failure removes exactly its layer; a success patch conflicting with a later layer is
reconciled; no inverse patches are computed.

### Phase 11 — Live streaming

Effect streaming RPC merged through the same normalized cache.

**Acceptance:** live patches upsert into the store; a live/read race has a defined
order; no parallel live-state architecture exists.

### Phase 12 — Persistence and SSR

`RemotePersistence` over Effect `KeyValueStore` (browser layer resolved first);
`Remote.prefetch` + in-process RPC for SSR; cache serialization and hydration.

**Acceptance:** a version-mismatched cache clears and refetches; SSR serializes and
hydrates without mismatch; persistence uses only Effect storage layers.

### Phase 13 — Rebuild Agent and Sync on Surface

Delete the duplicated projections; wire `Sync.journalContract`; keep adapters
leaf-only.

**Acceptance:** `Agent.context`/`Agent.pick` and `sync/projection.ts` are gone; the
existing Sync/durable invariants (§10.2) still hold; published packages remain
installable until their replacements ship; migration notes exist.

### Phase 14 — Tooling

`Surface.registry`, DevTools Surface inspection, dependency/capability display,
optional development MCP exposure. No behavior changes.

**Acceptance:** DevTools shows observes/emits for a registered Surface; duplicate
names are rejected; production exposure remains separately opt-in.

---

## 16. Testing and verification

- Every phase ships with tests; **every guard is mutation-verified** (break the
  code, watch the test fail, revert).
- Inference is pinned with `*.test-d.ts` + `@ts-expect-error`; an unused directive
  must fail `tsc`.
- `Remote.plan`, `Remote.merge`, and replay are pure and **property-tested** over
  generated inputs (including cyclic requirements and empty/fully-satisfied caches).
- Presence and tombstone semantics have explicit cases (missing vs present-undefined
  vs present-null vs stale vs not-found).
- RPC layers are tested with Effect's in-process/test RPC tooling; any fake is built
  from the protocol spec.
- Remote server authorization has explicit tests for field-level denial, hidden
  existence, and partial entities.
- Run the four CI checks plus `pack:check` when manifests/builds change; run them
  before the commit, not after.
- Negative type tests + runtime tests together; neither alone is sufficient.

**Definition of done for the whole revision:** the canonical Todo example (§11)
compiles and runs with no explicit generics, no casts, no duplicated Message schema,
no string tags, and no second reducer; Agent, Sync, and Remote all derive from one
`App` scope; `foldkit-durable` is untouched; the existing published packages remain
installable; CI is green.

---

## 17. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Inference (ModelRef tree, nested Projections, Submodel Model, view subset) | **Critical** | Phase 0 gate before any architecture; negative type tests. |
| `HtmlBuilder` subset variance (`Surface.view`) | High | Phase 0 case 3; fallback is a branded builder or a small Foldkit core seam. |
| `Remote.make` Model widening to `any` | High | Runtime registry + small scope brand over giant conditional unions; negative tests. |
| Message union identity is structural | Medium | Provide all structural safety; decide on a hidden union brand early. |
| Browser IndexedDB `KeyValueStore` missing | Medium | Resolve the platform dependency in Phase 12 before designing persistence. |
| `effect/unstable/rpc`/`persistence` churn | Medium | Pin rc.112; re-verify exact syntax in one isolated module; keep semantic types stable. |
| Scope (5 packages, rewrite Agent+Sync) | High | Phased, independently reversible; keep published packages working. |
| Concurrent sessions editing the tree | Medium | Stage only owned files; never `git add -A`; coordinate on `packages/surface/`. |
| Normalized store performance | Medium | Render optimization is a later interpreter; correctness first. |

---

## 18. Release and migration

- New packages start private, `0.0.0`, unpublished until Phase 1/3 acceptance holds.
- Existing published packages keep working (`foldkit-agent*`,
  `foldkit-sync@0.2.0`, `foldkit-durable@0.1.1`). Do not break them until their
  Surface-based replacement is proven and a migration path exists.
- The Surface-based Agent/Sync APIs are breaking: ship under new minor versions with
  deprecation notes, or as new packages, after Phase 13.
- `foldkit-durable` is unaffected and needs no migration.
- Update `CHANGELOG.md`, the root umbrella README, and affected package READMEs as
  each phase lands. `PLAN.md` (git-ignored) is scratch; this document is durable.
- Versioned formats/wire/state changes require an explicit bump and policy; the
  existing durable `user_version` migration and sync replica/clock version errors
  are the precedent.

---

## 19. Glossary

- **ModelRef** — typed, optic-backed reference to a Model location plus its focus
  Schema and dependency metadata.
- **Projection** — an observable view of a root Model: value Schema + dependency
  tree + pure `read`.
- **Surface** — a Projection plus a Message subset (and optional Params); an access
  boundary for a feature/subsystem, distinct from a Submodel.
- **Submodel** — an ownership boundary that owns Model/Message/`update`/Commands.
- **Entity** — a Schema.Struct plus stable identity and normalization metadata.
- **EntityRef** — a normalized reference to an entity (`User:u7`).
- **Selection** — a derived Struct Schema plus remote field-requirement metadata.
- **Requirement** — pure data describing which entity fields a Projection needs.
- **RemoteData** — the tagged union of loading/error/value states for remote data.
- **Planner** — `Remote.plan`, the pure function diffing requirements against the
  cache to produce the minimal missing-field plan.
- **Normalized store** — the entity/connection cache inside `Remote.Model`.
- **Presence** — field-level "is this value known/stale/absent" metadata.
- **Tombstone** — a cached not-found marker for an entity.
- **Optimistic layer** — an overlay of pending mutations over the base cache.
- **Capability** — a Message a feature/Surface may produce; not authorization.

---

## 20. Immediate next step and open questions

**Next step:** Phase 0. Build the smallest inference spike (one scratch module plus
`*.test-d.ts`) covering the five cases in §15, run `pnpm typecheck` and `pnpm test`,
and record results under a new "Phase 0 results" section here. Do not begin Phase 1
until every case infers without explicit generics or casts — or until this document
is amended with the architecture changes the failures imply.

**Open questions to resolve during or before Phase 0:**

1. In-repo `foldkit-surface` (recommended) vs an upstream Foldkit proposal.
2. Does `HtmlBuilder<Message>` support the subset narrowing `Surface.view` needs, or
   is a Foldkit core seam required? (Variance analysis is in §6.3/§14.)
3. Do we attach a hidden union identity to Message constructors for nominal
   application isolation?
4. Which existing example(s) become the Phase 2 validation target?
5. Which browser `KeyValueStore` (IndexedDB) will Phase 12 use?
6. Do `ModelRef.at` on a record and `.index` on an array return `Option`, and where
   does absence flow (Schema vs value)?
