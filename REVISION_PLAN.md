# Revision Plan — Foldkit Plus reorganization around Surface and Remote

**Status:** authoritative plan and handoff. Supersedes
`packages/surface/DESIGN_BRAINSTORM.md`, `packages/surface/BACKBONE.md`,
`packages/surface/REMOTE.md`, and `packages/surface/DRIZZLE.md` wherever they
conflict; those remain for provenance. This document is written to be executable
by someone with **no prior context**.

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
| `defineSync({ message, shared, empty, durable, replay })` | `packages/sync` | Kept as the low-level escape hatch; `Sync.make` compiles to it |
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

RemoteDrizzle = Remote Selection/Query graph ──▶ Drizzle relational query
                (fields ──▶ columns, refs ──▶ predicates, relations ──▶ loads)

Connection = ordered entity references + explicit known boundaries + overlays
             (pages, live events, and optimistic inserts are all evidence about it)
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
  Message, options?)`. **Invariant in `Message`** — see §15 Phase 0 results.
- `foldkit/command`: `define`, `mapEffect`, `mapMessage`, `mapMessages`,
  `Interruptible`.
- `foldkit/subscription`: `make`, `aggregate`, `lift`, `persistent`, `fromEvent`,
  `animationFrame`.
- `foldkit/submodel`: `defineView` and submodel types.
- The `foldkit-agent*` packages already peer on `foldkit`; `foldkit-durable` and
  `foldkit-sync` peer only on `effect`.
- **Consequence:** the revision needs no unreleased Effect feature. Risk is
  inference and `unstable/*` churn, not missing primitives.

### 3.5 Drizzle (pinned and probed)

`packages/surface/DRIZZLE.md` builds on two Drizzle features: an Effect-native
PostgreSQL driver (`drizzle-orm/effect-postgres`, over `@effect/sql-pg`) and
Effect Schema derivation from tables (`drizzle-orm/effect-schema`).

**Installed at the workspace root and verified against the installed `.d.ts`:**
`drizzle-orm@1.0.0-rc.4` and `@effect/sql-pg@4.0.0-rc.112` (matching the pinned
`effect`). Their surfaces:

- `drizzle-orm/effect-postgres`: `make` / `makeWithDefaults`, `EffectPgDatabase`,
  `EffectPgSession`, `EffectPgSessionOptions`, `DefaultServices`, `EffectLogger`,
  `effectPgCodecs`, `EffectPgQueryEffectHKT` / `EffectPgQueryResultHKT`.
- `drizzle-orm/effect-schema`: `createSelectSchema` / `createInsertSchema` /
  `createUpdateSchema` plus the `BuildSchema` / `BuildRefine` types.

**Runtime correction (probed 2026-09-11, not static).** Reading the `.d.ts` is
not enough: importing `drizzle-orm/effect-postgres` under `effect@4.0.0-rc.112`
fails immediately with `TypeError: Schema.TaggedErrorClass is not a function`.
No published Effect exports `TaggedErrorClass` (checked rc.112 through rc.115),
and `drizzle-orm@1.0.0-beta.22` — the last line that uses the rc.112-era
`Schema.TaggedError` — builds on Effect 3 (`Effect.Service`, `@effect/sql-pg@^0.49`).
So **no published Drizzle version's `effect-postgres` driver runs on this
workspace's pinned Effect.** The compiler half (`drizzle-orm/pg-core`,
`drizzle-orm/effect-schema`, `PgDialect`) is unaffected and works at runtime.

**Proven execution path instead:** render the compiled Drizzle `SQL` with
`PgDialect.sqlToQuery` and execute the `{ sql, params }` through
`@effect/sql-pg`'s `SqlClient.unsafe` (rc.112-compatible). Verified end-to-end
against a real `postgres:17` container: a parameterized `select` with a pruned
column list returned the expected rows. This keeps the "no connection captured"
invariant — the connection stays in the Effect Layer, not in the adapter. The
entity-source executor should target this path, not `EffectPgDatabase`.

**`@effect/sql-drizzle` is not used.** It has no `4.0.0-rc` line and its latest
peers `effect@^3.22.0`, so it is incompatible with the pinned rc. Because
Drizzle's own `effect-postgres` integration is equally unusable here, the
executor is the `PgDialect` + `SqlClient` bridge above. `foldkit-remote-drizzle`
stays provisional and value-bar gated.


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
  (webmcp/mcp/     (journal)                │
   a2a/native)                              ▼
                                    foldkit-remote-drizzle (provisional)
                                    Remote Selection/Query ──▶ SQL
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
| `foldkit-remote-drizzle` (provisional) | compiler from Remote `Entity`/`Selection`/`Query` to Drizzle's typed query graph; rows → normalized patches | `foldkit-remote`, `drizzle-orm` (peer), `effect` |
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
`foldkit-remote-drizzle` is **provisional**: it earns a package only if it meets
the value bar in §8.14.

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
const TodoSync    = Sync.make(App, "TodoSync", { ... })
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
  readonly Params: Schema.Schema<Params> | undefined
  readonly Message: Schema.Schema<Message>
  readonly messages: ReadonlyArray<MessageConstructor>
  readonly projection: (params: Params) => Projection<RootModel, Model>
}
```

**Decision (Phase 2):** `Model` and `dependencies` are **not** stored on the
descriptor. A parameterized projection may read `params`, so evaluating it eagerly
with `undefined` is invalid; they are derived on demand via `projection(params)`.

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

`Surface.read(surface, model, params)` is pure. A **Renderer** is
`(model: ProjectedModel, h: MessageNarrowedBuilder) => Html`:

- `Surface.view(surface, render)` binds a Renderer to a Surface (type-level:
  `Model` and `Message` come from the Surface). It is Model-consuming, not
  Root-consuming, so a parent can hand a child the portion of its Model the child
  needs.
- `Surface.rootView(surface, params, render)` is the application boundary:
  consume the Root Model, project it, and pass the projected Model to the
  Renderer. A `Subset` check rejects a Surface whose Messages the app cannot route.
- `Surface.embed(childRenderer)` composes a child: `ParentModel extends ChildModel`
  enforces "child Model requirement ⊆ parent projected Model" and `Subset`
  enforces "child Message set ⊆ parent Message set".
- `Surface.registry(App, [surfaces])` is explicit (no hidden global registry).

`HtmlBuilder` is invariant, so a superset builder cannot be *structurally*
narrowed; `view`/`embed`/`rootView` cast soundly, and the subset checks are what
make the cast safe.

**Submodel interop (Phase 2):** a Surface renderer embeds a Foldkit Submodel via
`h.submodel`, and `toParentMessage` must land inside the Surface's Message set
(the builder is narrowed to it). The reverse — a Submodel view embedding a
Surface via `Surface.embed` — type-checks only when the Submodel's Message
universe includes the Surface's Messages; the usual direction is Surface →
Submodel. An access boundary and an ownership boundary compose without either
gaining the other's authority.

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
- `Surface.view`'s variance (resolved in Phase 0): `HtmlBuilder<M>` is
  **invariant** in `M`. `MessageUniverse<M>` is `(message: M) => M`, and
  `HtmlAttributes.OnClick` both takes and returns the Message, so a superset
  builder is **not** assignable to a subset builder. `Surface.view` narrows the
  renderer and uses a sound cast internally; a Foldkit core seam is the durable
  alternative (§15 Phase 0 results).
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

**Decision:** a relation is an `Entity.ref` (or `Entity.refTo`) Schema whose
decoded form is a **reference** and encoded form is a string:

```text
decoded:  owner: EntityRef<"User">   // { entity: "User", id: "u7" }
encoded:  owner: "User:u7"
```

`Entity.ref(Entity)` targets a known entity; `Entity.refTo("Name")` targets by
name for recursive or forward references. A ref cannot reconstruct a full entity
(its other fields are absent) and dereferencing is a store concern, so the
decoded side is the reference, not `User`. **Because relations never inline the
target schema, recursive relations cannot arise through the schema graph** — no
`Schema.suspend`, no cycle. (This supersedes the earlier "decoded: `User`" note.)

**Edge cases**

- Encoding a relation with no loaded target (a dangling reference must remain a
  valid reference, not become `undefined`).
- Round-tripping a relation through `Schema.encode`/`decode`.
- A relation that is `null` (explicitly no owner) vs absent.
- Partial selections that include the relation but not its fields.
- Recursive relations: express with `Entity.refTo("Name")`; there is no schema
  cycle to terminate.

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

### 7.5 Query, Connection, and Mutation

```ts
const ProjectsByOwner = Query.make("ProjectsByOwner", {
  Input: Schema.Struct({ ownerId: UserId, sort: SortOrder }),
  Result: Query.connection(Project, {
    edgeKey: Schema.String,                         // optional; default edge identity is EntityRef
    live: { prepend: "visible", append: "boundary" }, // insertion policy (see §8.13)
  }),
})

const RenameProject = Mutation.make("RenameProject", {
  Input: Schema.Struct({ id: ProjectId, name: Schema.String }),
  Output: Schema.Struct({ projectId: ProjectId }),
})
```

A `QueryRef` is a typed reference to one logical connection plus a window:

```ts
const latest = pipe(ProjectsByOwner.ref({ ownerId, sort: "newest" }), Query.first(25))
const older = pipe(
  ProjectsByOwner.ref({ ownerId, sort: "newest" }),
  Query.after(cursor),
  Query.first(25),
)
```

**Invariants**

- **Connection identity ≠ pagination request identity.** Connection identity is the
  query descriptor plus its filter/sort input (canonical encoded) — **not**
  `first`/`last`/`after`/`before`. `latest` and `older` above populate the *same*
  normalized Connection; they are different windows of one logical structure.
- A `QueryRef`'s cache key derives from the descriptor + canonical encoded input;
  application code never writes cache-key arrays or cursors.
- `Query.connection` options are part of the descriptor: `edgeKey` (when the same
  node may appear more than once) and `live` (insertion policy).
- Mutation `Output` is inferred; no explicit generics.

**Edge cases**: canonical input key order; two inputs that encode equal; an input
that is itself a relation; `edgeKey` present vs the `EntityRef` default; a Query
whose `Result` is a single entity rather than a connection.

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
  entities: EntityStore        // values + presence (+ tombstones)
  connections: ConnectionStore // ordered refs + explicit known boundaries + overlays
  requests: RequestState
  mutations: MutationState
}
```

**Invariants**

- The cache is part of the Model; there is no hidden mutable cache.
- Cache updates happen only through Remote Messages processed by `Remote.update`.
  Network code never mutates the store directly, so DevTools/time-travel see cache
  evolution.
- **One reconciliation engine.** The four producers of new facts — `ReadBatch` (a
  page), `MutationResult`, `OptimisticOperation`, and `LiveEvent` — all feed
  `EntityStore.apply` and `ConnectionStore.apply`. Pagination and live data are not
  separate subsystems; they are evidence about the same normalized world (§8.12,
  §8.13).
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
- A page response arriving after the connection was invalidated.
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
loading/error/data are visible application states. A connection projects as
`RemoteData<Connection<A>>` (see §8.12).

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
const Live   = Rpc.make("FoldkitRemoteLive",   { payload: LiveRequirement, success: LivePatch, error: RemoteLiveError, stream: true })
const RemoteRpc = RpcGroup.make(Read, Mutate, Live)
```

**Verified rc.112:** `Rpc.make(tag, { payload, success, error, stream: true })` — the
`stream: true` flag derives `RpcSchema.Stream<Success, Error>` itself; do not pass
`success: RpcSchema.Stream(...)`. `RpcGroup.make(...rpcs)`; handlers via
`RpcGroup.toHandlers/toLayer`; in-process tests via `RpcTest.makeClient(group)`.

Verify exact syntax against rc.112.

**Invariants**

- Batching is semantic (`ReadBatch` built by Remote), not transport-dependent.
- Reads may dedupe/union/batch. **Mutations preserve order and are never merged or
  auto-batched** (a future explicit transaction abstraction may batch them).
- Live data is effect streaming RPC merged into the same store via Messages. The
  live method carries a resume cursor and emits ordered, identified events; replay
  semantics are part of the protocol, not the transport (§8.13).
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

Mutation results, live events, and optimistic overlays can describe the same change.
Every cache operation therefore carries a stable identity (`MutationId`,
`LiveEventId`, `EdgeIdentity`), an optimistic overlay records which authoritative
result settles it, and inserting an edge already present is a no-op (§8.13).

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

### 8.12 Connections (normalized ordered data)

**Reframe:** a connection is a normalized ordered data structure. Pagination and
live events are merely different ways of learning more facts about it. One
reconciliation model handles initial fetch, next/previous page, optimistic insert,
live insert/delete, mutation result, refetch, and reconnect.

```text
Entity store            Connection store
Project:p1              ProjectsByOwner({ ownerId: u1, sort: newest })
Project:p2
Project:p3              known ordering: p9 p7 p4 p2 p1
Project:p4              known ranges:
                          HEAD ───── cursor:C1
                                    gap?
                              cursor:C2 ───── TAIL
```

**Do not store a flat array plus `hasNext`.** If page 1 is `A B C D` and page 3 is
`I J K L` with page 2 unloaded, a flat array falsely claims `A B C D I J K L` are
adjacent. Represent **segments** with explicit boundaries:

```ts
interface ConnectionState {
  readonly segments: ReadonlyArray<Segment>
  readonly optimistic: ReadonlyArray<ConnectionOverlay>
  readonly live: LiveState
  readonly stale: boolean
}

interface Segment {
  readonly edges: ReadonlyArray<EdgeRef>
  readonly start: Boundary
  readonly end: Boundary
}

type Boundary =
  | { readonly _tag: "Terminal" }                    // definitively the head/tail
  | { readonly _tag: "Cursor"; readonly cursor: Cursor }
  | { readonly _tag: "Unknown" }                     // more may exist beyond here
```

**Edge identity.** Default edge identity is the `EntityRef`. When the same node may
legitimately appear more than once, `Query.connection(Entity, { edgeKey: Schema })`
supplies a server-provided edge key. Do not bake in a false universal assumption.

**Merge is pure and deterministic.** `Connection.merge(current, page)` reconciles a
page against the current connection using connection identity, edge identity, the
request cursor, and the response start/end cursors. No RPC, no Effect, no clock —
just deterministic data reconciliation that can be property-tested. Overlapping
segments merge without duplication (`A B C D` + `C D E F` ⇒ `A B C D E F`).

**Boundaries survive optimistic and live inserts.** An optimistic insert at the
unresolved far end must not pretend it lives inside a contiguous loaded server range.
Model it as an overlay:

```text
SERVER-KNOWN          OVERLAYS
A B C ... T           prepend: optimistic X
[more after]          append beyond unresolved edge: optimistic Y
```

Visible ordering = known server segments + overlays. When the server later returns
canonical placement, the overlay disappears and the canonical edge is inserted (edge
identity makes this idempotent).

**Public API stays tiny.** A Surface receives `RemoteData<Connection<A>>` with
`items`, `hasNext`, `hasPrevious` (internally, `next`/`previous` as
`Option<PageRef>`). The UI emits ordinary Foldkit Messages (`ClickedLoadMore`);
`update` issues `Remote.next(...)` / `Remote.previous(...)` as Commands — a
declarative "extend the known forward/backward range of this connection", with no
cursor bookkeeping in the UI. `Connection` carries its own boundaries.

**Invariants**

- Connection identity excludes pagination arguments; `first(25)` and
  `after(cursor).first(25)` populate the same connection.
- All connection mutations (page merge, optimistic overlay, live op, mutation
  result) go through one reducer and produce the same canonical structure.
- `Connection.merge` is pure and deterministic.
- `hasNext`/`hasPrevious` derive from boundaries, never from "we got fewer rows".
- A connection is never an array that claims adjacency it cannot prove.

**Edge cases**

- Page 1 then page 3 with no page 2 (the gap is preserved).
- Forward, backward, jump-to-cursor, SSR partial window, prefetched page.
- Overlapping pages with reordered or duplicated edges.
- `edgeKey` collisions; a node legitimately appearing twice.
- An optimistic insert beyond an unresolved boundary, later confirmed canonically.
- An insert at the head while a middle window is visible (see the live policy below).
- A mutation result and a live event for the same insert (dedupe).
- Invalidation while an optimistic overlay is pending.
- A `stale` connection rendered as `RemoteData.Refreshing`.

### 8.13 Live data

**Two fundamentally different live facts.**

- **Entity facts** update normalized entities:
  `EntityChanged({ ref, changed: ["status"] })`, or a normalized
  `EntityPatched({ ref, patch })` / `EntityDeleted({ ref })`.
- **Connection facts** describe membership/order and cannot be expressed as entity
  patches: `Connection.prepend/append/insertBefore/insertAfter/remove/move/invalidate`.

Both flow through `Remote.Message` → `Remote.update` into `EntityStore.apply` /
`ConnectionStore.apply` — the same reducers pages use.

**Events should be invalidations, not CDC payloads.** Prefer
`EntityChanged(Project:p1, fields = ["status"])`; RemoteServer then re-resolves the
**currently selected, authorized** fields for active subscribers and sends the
normalized patch. This keeps authorization centralized, supports computed fields,
lets different subscribers hold different selections, and never leaks raw database
rows. Direct trusted patches are a later optimization.

**Selection-aware fan-out.** A live event declares the fields that changed. A
subscriber that does not select those fields is not woken and nothing is refetched.
Because Surface exposes active selections, live subscriptions derive from active
Surfaces: union their requirements while mounted, drop a requirement when the Surface
unmounts. Surface lifetimes become live-subscription lifetimes; there is no manually
managed subscription list.

**Streaming RPC is transport, not reliability.** Delivery while connected does not
answer: what if the connection drops, events were missed, the server restarts, events
arrive out of order, or a client is offline for 30 minutes? Make replay part of the
protocol from day one:

```ts
Live({ requirements, after: Option<LiveCursor> })
// yields { cursor: LiveCursor, event: LiveEvent }
```

The client persists the last applied cursor; on reconnect it subscribes after it. The
server replays from there, or answers `ResumeUnavailable`, in which case the affected
requirements are marked stale, refetched, and a new cursor is established. This is
stronger than "reconnect and hope".

**Ordering and gaps must be defined.**

- Ordering is promised **per live stream/session** (or per connection/topic), never
  globally unless the backend can provide it.
- Events for the same entity/connection are applied in cursor order.
- Duplicates are ignored (`cursor <= lastApplied` ⇒ no-op).
- A gap (`expected 100`, `received 105`) triggers a resume request, or
  invalidation/refetch when the transport cannot resume.

**Mutation / live / optimistic deduplication.** Rename a project and three things
describe the same change: the optimistic patch, the mutation response, and a live
event. Entity values are idempotent, but connection insertion is not (`prepend` three
times inserts three edges). Every cache operation carries a stable identity
(`MutationId`, `LiveEventId`, `EdgeIdentity`); an optimistic overlay records which
authoritative result settles it; inserting an edge already present is a no-op.

**Live + optimistic ordering is what overlays are for.** Chat example: canonical
`A B C`, optimistic `X`, live `Y` → visible `X Y A B C`. When the server confirms
`X`, remove the optimistic edge and insert the canonical one; edge identity prevents
flicker or duplication. No imperative array surgery.

**Live insertion policy (pagination boundaries).** Viewing the latest 30 messages and
a new message arrives → prepend visibly. Viewing items 101–120 and an item is
inserted at the head → it should not suddenly appear. Make this explicit:

```ts
Query.connection(Project, { live: { prepend: "visible", append: "boundary" } })
```

Semantics: `visible` (alter the visible window), `boundary` (record the new edge
outside the loaded boundary), `invalidate` (mark stale and refetch), `ignore` (do not
subscribe to membership changes). **Invalidation is a correctness escape hatch**, not
an architectural failure: when server logic cannot determine the precise consequence,
emit `Connection.invalidate`.

**Invariants**

- Pagination and live share one `Connection` structure and one reducer.
- Live events are ordered per stream; duplicates are ignored; gaps
  resume-or-invalidate.
- The live cursor is monotonic and persisted; resume failure is explicit
  (`ResumeUnavailable`), never silent.
- Subscriptions derive from active Surfaces and are selection-aware.
- Invalidation is always available and always correct.

**Edge cases**

- Resume unavailable after a restart; server cursor retention/expiry.
- Out-of-order delivery; duplicate delivery; gap detection.
- A live event for a field no active Surface selects (skip).
- A live connection op for a connection no Surface observes (skip).
- A live insert into a middle window under each policy
  (`visible`/`boundary`/`invalidate`/`ignore`).
- A live delete of an optimistically inserted edge.
- Invalidation racing an in-flight page request.
- Field authorization changing between an event and its re-resolution.

### 8.14 Drizzle adapter (`foldkit-remote-drizzle`, provisional)

**Thesis:** not a Drizzle driver — a **compiler from Remote's declarative
entity/selection/query graph into Drizzle's typed relational query graph**, and
back.

```text
Remote semantics              Drizzle semantics
Entity                ←────→  Table
Selection             ────→   partial SELECT
EntityRef             ────→   PK predicate
relation Selection    ────→   join / batched relation load
QueryRef              ────→   WHERE / ORDER / LIMIT
Connection            ←────   rows + pagination
EntityPatch           ←────   selected row
```

Everything else (connection management, Layers, SQL error wrapping, transactions,
Schema generation from tables) stays with Drizzle/Effect.

**API sketch**

```ts
const User = RemoteDrizzle.entity("User", users, {
  schema: { id: UserId },                       // per-column Schema override (branded id)
})

const Project = RemoteDrizzle.entity("Project", projects, {
  schema: { id: ProjectId },
  relations: { owner: RemoteDrizzle.one(User, { field: projects.ownerId }) },
})

const ProjectSource = RemoteDrizzle.source(Project)   // handles ids + Selection

const ProjectsByOwnerSource = RemoteDrizzle.query(ProjectsByOwner, {
  entity: Project,
  where: ({ ownerId }) => eq(projects.ownerId, ownerId),
  orderBy: desc(projects.createdAt),
  cursor: { column: projects.createdAt, direction: "desc" },   // pagination
})
```

- `RemoteDrizzle.entity(name, table, { schema?, relations? })` can derive the Entity
  Schema from the table via `createSelectSchema`, then delegate id/brand overrides
  to Drizzle's per-column Schema override — no second mapping language.
- `RemoteDrizzle.source(Entity)` maps a Selection's fields to columns, executes a
  batched SQL query, and returns normalized patches.
- `RemoteDrizzle.query(Query, { entity, where, orderBy, cursor })` handles
  pagination and derives the `Connection`.

**Invariants**

- The adapter captures **no database connection**; generated Sources require the
  Drizzle Effect service (the Layer model is preserved).
- Statements are batched by **entity + id list + column set**. The planner already
  produces exactly that shape (`Remote.plan` output), so the adapter does not
  re-plan.
- Relation metadata describes **how entities relate**, not what SQL strategy to run;
  the adapter may choose a JOIN or two-stage batched loads.
- Selection is the single source of columns; no hand-written DTO or column mapping.
- Server selection authorization still applies in the compiler: a Selection cannot
  cause an unauthorized column to be read (defence in depth with §8.10).
- The package is **provisional**. Build it only if it makes all of these automatic:
  field pruning, batched ids, relation fetching, normalization, Selection-aware
  joins, query pagination, and Schema derivation. If a generic `RemoteServer.entity`
  Source is nearly as short, do not ship the package.

**Edge cases**

- Column type vs branded/transformed field: id override, dates (`Schema.Date` vs a
  `timestamp` column), `numeric`/`NumberFromString`, `jsonb`, arrays.
- SQL `NULL` vs Remote "present null" vs "missing" (§8.3): a `NULL` column maps to a
  present-null value, not to absence.
- Soft-deleted rows: map to a tombstone/`NotFound` rather than a value.
- A relation whose FK is non-null but whose target row is gone (dangling).
- A relation whose FK is nullable (`owner_id NULL`): absent relation vs present null
  — define it.
- The same target id appearing many times in a batch (dedupe the relation load).
- Cursor pagination requires a **stable total order** (add a tie-breaker column, or
  a page can repeat/skip rows).
- A Selection that selects only a relation (no scalar id): the compiler still needs
  the PK for normalization.
- Field-level authorization interacting with column selection.
- Multi-tenant scoping must be added to `where` by the Source, never inferred from
  client input.
- Mutations are **not** an adapter DSL initially: use Drizzle's Effect-native `db`
  directly inside `RemoteServer.mutation` (maybe `RemoteDrizzle.returning` /
  `columns` / `normalize` helpers later).

**Phase 14 status (provisional).** Implemented and tested without a database:
`entity(name, table, {schema?, relations?})` binds an Entity to a table and derives
the Entity Schema from `drizzle-orm/effect-schema`; `columnsFor` prunes a Selection
to its scalar columns; `relationsFor` yields relation bindings; `whereIds` renders a
whole id batch as one `IN`; `cursorCondition` and `queryPlan` compile the
filter/cursor/limit. Tests assert Schema derivation, field pruning, relation/scalar
separation, id batching, and cursor SQL (rendered with `PgDialect`, no DB).

**Value bar:** the hand-written `RemoteServer.entity` Source must map a Selection's
fields to columns and build the id batch by hand, and a naive `select({...})` does
not prune per request; the compiler removes that mapping and prunes correctly. The
execution bridge (`RemoteDrizzle.source`/`query` running the Effect Drizzle `db` and
normalizing rows) is **not** implemented and has no execution test (no Postgres in
CI). The package stays **private/provisional** until that bridge demonstrates a
materially shorter Source than the generic form with correct per-selection pruning.

### 8.15 Fate parity (framing for acceptance)

The design aims to capture Fate's architectural benefits as native Foldkit + Effect
primitives, and to add what Fate lacks:

| Fate concept | Foldkit stack |
| --- | --- |
| view / fragment | `Selection` + `Projection` |
| data masking | `Surface` |
| normalized cache | `Remote.Model` entity store |
| entity refs | `EntityRef` |
| field-level fetch planning | `Remote.plan` |
| batched requests | Remote `ReadBatch` + Effect RPC |
| transport | Effect RPC protocol Layers |
| server data views | `RemoteServer.entity/query` |
| mutations | Message → Command → `Remote.mutate` |
| optimistic updates | Remote optimistic layers |
| live views | streaming RPC → normalized patches |
| persisted cache | Effect Persistence / KV |
| query composition | Selection + Surface composition |
| normalized connections | `ConnectionStore` segments + boundaries |
| connection events | `Connection.prepend/append/remove/move/invalidate` |
| field-aware live fan-out | selection-aware live events |
| live resume | monotonic `LiveCursor` + `ResumeUnavailable` |

Beyond Fate: **Message capability masking** (`messages:`), full transition history
through Foldkit Messages, one contract shared by Agent/Sync/Remote, and no
React/Suspense render control flow (states stay explicit in `RemoteData`).

What Fate is ahead on — implementation, not architecture: nested relation planning,
partial-field correctness, query/connection reconciliation, optimistic rebasing,
live + optimistic interaction, garbage collection, concurrent/racing requests,
deletion semantics, pagination insertion. These are the hard parts and must be
earned (see §13, §17).

**Parity goal for acceptance:** data masking, composition, normalized entities,
field presence, minimal fetching, batching, server field selection, ORM pruning,
mutation reconciliation, optimistic updates, normalized connections with
boundary-aware pagination, ordered and resumable live data, SSR, and persistent
cache. Deliberately **not** copied: Suspense-style render control flow.

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
const TodoSync = Sync.make(App, "Todos", {
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
  protocol primitive and escape hatch; `Sync.make` compiles down to it.
- `foldkit-durable` stays independent; Sync produces the replay contract via
  `TodoSync.journalContract()` → `{ operation:{encode,decode},
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

const TodoSync = Sync.make(App, "TodoSync", {
  documentId: documentId("todos"),
  model: Sync.project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo, Message.RenamedTodo],
  replay: updateShared,
})

const journal = yield* makeJournal({
  ...TodoSync.journalContract(), file, opId, actorId, authorize,
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
| Relation decoded form | A reference (`EntityRef`), not the inline target | A ref cannot reconstruct a full entity; dereferencing is a store concern, and not inlining makes recursive relations a non-issue. |
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
| Drizzle adapter | A compiler from Selection/Query to Drizzle, **not** a driver; provisional | Drizzle is Effect-native and derives Schemas; the adapter earns its place only via the value bar. |
| Drizzle mutations | Use Drizzle's Effect `db` directly; no mutation DSL initially | Drizzle's Effect API is already good; do not hide it prematurely. |
| Drizzle relations | Metadata describes relationships; the adapter picks JOIN vs batched load | Do not force JOINs; batching is the normalized-system advantage. |
| Connection identity | Query descriptor + filter/sort input; pagination args excluded | Pages and live events are evidence about one logical connection. |
| Connection representation | Segments + boundaries (+ overlays), not a flat array + `hasNext` | A flat array falsely claims adjacency between non-contiguous pages. |
| Edge identity | Default `EntityRef`; optional server `edgeKey` | The same node may legitimately appear more than once. |
| Page merge | Pure deterministic `Connection.merge` | Property-testable; one reducer for pages, live, optimistic, and mutation results. |
| Live events | Prefer invalidations (`EntityChanged(fields)`); the server re-resolves selected, authorized fields | Centralizes authorization; supports computed fields and per-subscriber selections. |
| Live delivery | Ordered per stream, deduped, monotonic resume cursor, explicit `ResumeUnavailable` | A streaming transport alone does not make live reliable. |
| Live/optimistic dedupe | Stable `MutationId`/`LiveEventId`/`EdgeIdentity`; overlays know their settler | Prevents triple inserts from optimistic + mutation + live. |
| Live insertion policy | Per connection: `visible`/`boundary`/`invalidate`/`ignore` | An insert at the head must not disturb a middle window. |
| Dependency shape | `readonly string[]`, absolute from the Root Model; `Projection.of` on a raw Schema contributes none | Only a `ModelRef` knows a Model path; a raw-Schema projection is not a Model projection. |
| Dependency merge | `struct`/`array`/`option`/`select` union and de-duplicate; result is order-independent | Masking, DevTools, and invalidation read one canonical set. |
| `ModelRef.select` on an optional focus | Maps inside `Option`, preserving absence (`Projection<Root, Option<P>>`) | No silent collapse of `Option<Option<A>>`. |
| `Projection.array`/`option` | Wrap the whole value (`ReadonlyArray<Root>→ReadonlyArray<Value>`, `Option<Root>→Option<Value>`) | Avoids accidental double-wrap; nesting stays explicit. |
| `Surface.registry` | Explicit descriptor; throws on a duplicate `name` | No hidden global registry; fail fast. |
| Reserved ModelRef names | `at`/`index`/`select`/`Schema`/`optic`/`dependency`/`get`/`set` are reserved; a Struct field with one of these names throws when the tree is built | A field must not silently shadow a method. |
| Surface rendering | Renderers are Model-consuming; `rootView` is the Root boundary; `embed` composes with Model and Message subset checks | A parent has its projected Model, not Root, so children must read from it structurally. |
| Surface descriptor | No eager `Model`/`dependencies`; derive via `projection(params)` | A parameterized projection reads `params`, so eager evaluation with `undefined` is invalid. |
| Surface + Submodel | Surface renderer embeds a Submodel via `h.submodel`; `toParentMessage` narrows to the Surface's Messages | Access boundary and ownership boundary compose without gaining each other's authority. |

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

**Drizzle adapter**
- `NULL` vs present-null vs missing; soft-deleted → tombstone; nullable FK (absent
  vs null); dangling FK; duplicated target ids in a batch; unstable pagination
  order; a relation-only selection that still needs the PK; field authorization vs
  column selection; multi-tenant `where`; date/numeric/json/array column mapping;
  branded id override; mutations via the raw Effect Drizzle API.

**Connections / live**
- Non-contiguous pages (gap preserved); overlapping merge; reordered/duplicate edges;
  `edgeKey` collision; a node appearing twice; an optimistic insert beyond a
  boundary; a head insert while a middle window is visible; mutation+live insert
  dedupe; invalidate racing a page request; a stale connection rendered as
  `Refreshing`; live resume unavailable/expired; out-of-order/duplicate/gap events;
  selection-aware skip; live delete of an optimistic edge; authorization changing
  between an event and its re-resolution.

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
- `Optic.at` is a **prism**, not a lens: `replace` is a no-op on an absent key, so
  it cannot insert or remove. Keyed/optional `ModelRef` writes need container-aware
  setters (Phase 1).
- `Rpc.make` uses **`stream: true`**; it derives `RpcSchema.Stream<Success, Error>`
  itself. Passing `success: RpcSchema.Stream(...)` is not the rc.112 form. Handlers
  come from `RpcGroup.toLayer`; `RpcTest.makeClient(group)` is the in-process client.

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
- Matching a descriptor in an **invariant** position against `unknown` silently
  yields `never`. `Optic.Optional`, `ModelRef`, and `EntityDescriptor` are
  invariant in their focus/generic; pattern-match with `infer X, any`, not
  `infer X, unknown` (`ModelRef<infer R, unknown>` collapsed
  `Projection.struct`'s root to `never` in Phase 0).
- `EntityDescriptor.ref(id: F['id'])` makes the descriptor **contravariant in
  `F`**, so a `readonly EntityDescriptor<string, Fields>[]` constraint rejects
  concrete entities. Use `readonly EntityDescriptor<any, any>[]` at collection
  boundaries.
- A conditional type **distributes over a union**: `Value extends
  Option.Option<infer Inner> ? …` with `Value = None<A> | Some<A>` yields a union
  over `None`/`Some`, not one type. Wrap in a tuple (`[Value] extends [ … ]`) when
  the focus must stay whole; this broke `ModelRef.at('p1')` in Phase 1.
- A mutation that survives usually means redundancy, not missing coverage; remove
  the redundant guard rather than testing a window that does not exist.
- Vite 5 does not know `node:sqlite` as a builtin and rewrites a static import to
  `sqlite`; in a Vitest test use `createRequire(import.meta.url)('node:sqlite')`
  with a `typeof import('node:sqlite')` annotation.

**Foldkit**

- Message constructors carry `_tag` and are callable Schemas; `subset`/`guards`/
  `isAnyOf`/`match` are available.
- `HtmlBuilder<M>` is **invariant** in `M` (the private `MessageUniverse` phantom
  is `(message: M) => M`, and `OnClick` both takes and returns the Message). A
  superset builder cannot be assigned to a subset builder; narrowing needs a sound
  cast or a core seam (§15 Phase 0 results).
- `Refreshable`/`refresh` is AsyncData revalidation, not a shared-state refresh;
  do not reuse it for sync.

**Drizzle / remote adapter**
- Drizzle's Effect-native integration and `effect-schema` are external packages; none
  are installed here. Pin and probe them before Phase 14 (§3.5).
- The adapter captures no connection; generated Sources require the Drizzle service.
- Keep relation metadata declarative; do not bake a JOIN strategy into it.
- A `NULL` column is a present value, not absence.

**Connections / live**
- Streaming RPC is transport, not reliability: define replay (resume cursor,
  `ResumeUnavailable`) from day one.
- Fate is the correctness baseline for pagination boundaries, field-aware fan-out,
  connection events, and invalidation; match those behaviors rather than redesigning
  them.

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

#### Phase 0 results (completed — commit `eb14306`)

Artifact: `packages/surface` (private `0.0.0`). `src/index.ts` is the minimal
spike; `test/inference.test-d.ts` pins the type contract; `test/inference.test.ts`
is a mutation-verified runtime smoke test. `format:check`, `typecheck`, `test`
(608), `demo`, and `pack:check` are green.

| Case | Result | Evidence |
| --- | --- | --- |
| 1. `App.model` tree | **Pass** | `App.model.session.user.name: ModelRef<Model, string>`; `.at`/`.index` yield `Option`; an unknown field is an error. No call-site generics or casts. |
| 2. `Projection.of`/`.struct` | **Pass** | Unknown keys reject; a nested Projection on the wrong root rejects; `struct` infers the entry record from `ModelRef`s and `Projection`s. |
| 3. `Surface.view` narrowing | **Pass, with a seam** | The projected Model narrows and an undeclared Message fails inside the renderer. But a superset builder is **not structurally assignable** to a subset builder, so the app-level view needs a cast or a core seam. |
| 4. `Remote.make`/`select` | **Pass** | `Data.Model` embeds in a `Schema.Struct`; `App.model.remote` is typed (unknown, not `any`); `Remote.select` yields `RemoteData<…>`. |
| 5. `Selection`/`Entity.patch` | **Pass** | `Selection.make` derives the picked Struct; `Entity.patch` rejects an unknown field and a mistyped field. |

**Case 3 finding — the one architecture decision this gate produced.** `HtmlBuilder<Message>`
is **invariant** in `Message` for two independent reasons: the private
`MessageUniverse` phantom is `(message: Message) => Message` (invariant), and
`HtmlAttributes.OnClick` is `(message: Message, options?) => { readonly message:
Message; … }` — the Message is a contravariant parameter *and* a covariant return
property. A `HtmlBuilder<AppMessage>` therefore cannot be assigned to a
`HtmlBuilder<SurfaceMessage>` for a strict subset. `Surface.view` returns a
function generic over the app's Message and performs a **sound narrowing cast**
internally: the renderer can only construct Messages from the Surface subset, and
the real builder accepts the superset, so passing the full builder where a
narrowed one is expected is safe. The durable alternative is a small Foldkit core
seam that retypes the builder singleton — `HtmlBuilder`'s runtime already has an
`@internal __htmlBuilder<Message>()`, it is simply not exported. **Decision
required before Phase 2** (open question 2): document the cast, or obtain the
seam. The cast is sound, but it is still a cast in a load-bearing place.

**Verdict:** Phase 0 passes. The only unresolved item is the builder seam (case
3), which does not block Phase 1 (Surface core) but must be decided before
Surface composition (Phase 2). The spike is a seed, not a final API: Phase 1
replaces the Surface half and Phase 3 splits out `foldkit-remote`.

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

`Query.make`, `QueryRef`, `ConnectionStore` with segments/boundaries, edge identity,
and the pure `Connection.merge`. Still no transport.

**Acceptance:** connection identity = descriptor + filter/sort input (pagination
args excluded), so `first(25)` and `after(cursor).first(25)` share one connection;
`Connection.merge` is pure, deterministic, and property-tested over overlap, gap,
reorder, and duplicate cases; non-contiguous pages preserve an explicit gap;
`hasNext`/`hasPrevious` derive from boundaries; the `edgeKey` override works; an
entity update propagates to every connection that contains it; no string cache keys
exist in application code.

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
retries do not duplicate a mutation's application (idempotency policy explicit); a
mutation result and a live event for the same entity are idempotent, and a mutation
result plus a live insert of the same edge do not double-insert (edge identity);
DevTools shows the cache mutation.

### Phase 10 — Optimistic layers

`Entity.patch`, optimistic layers, settle success/failure, overlapping-rebase proof.

**Acceptance:** overlapping optimistic patches rebase correctly on success; a
failure removes exactly its layer; a success patch conflicting with a later layer is
reconciled; an optimistic insert beyond an unresolved boundary records an overlay and
does not corrupt server-known ordering; a confirmed insert removes the overlay and
inserts the canonical edge without flicker; no inverse patches are computed.

### Phase 11 — Live data

Streaming Effect RPC with a resume cursor, ordered events, and connection/entity
facts, all merged through `EntityStore.apply`/`ConnectionStore.apply`.

**Acceptance:** a live event declares changed fields and wakes only subscribers that
select them; subscriptions derive from active Surfaces and disappear with them; a
dropped stream resumes from the persisted cursor or fails explicitly with
`ResumeUnavailable` and refetches; duplicate events are no-ops and a gap
resumes-or-invalidates; ordering is defined per stream; each insertion policy
(`visible`/`boundary`/`invalidate`/`ignore`) behaves as specified; no parallel
live-state architecture exists.

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

### Phase 14 — `foldkit-remote-drizzle` (provisional)

Only after Phases 7 and 12 are solid, and only if the adapter meets the value bar
(§8.14): Entity↔Table binding, `Entity` Source compilation from a Selection,
batched relation loads, Query→Connection with pagination, and Schema derivation.
Pin and probe Drizzle first (§3.5).

**Acceptance:** `RemoteDrizzle.source(Project)` fetches only the selected columns
for the requested ids and returns normalized patches; a nested relation selection
loads correctly (JOIN or batched) without N+1; cursor pagination is stable;
field-level authorization still holds; no connection is captured; the generated
Source is materially shorter than the generic `RemoteServer.entity` form (document
the comparison). **If the value bar is not met, do not ship the package** and record
why here.

### Phase 15 — Tooling

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
- `Connection.merge` is property-tested over generated segments, gaps, overlaps,
  reorders, and duplicates.
- Live ordering/dedupe/gap/resume are tested, including the `ResumeUnavailable` path
  and the four insertion policies.
- Selection-aware fan-out is tested: a change to a field no active Surface selects
  wakes no Surface.
- Presence and tombstone semantics have explicit cases (missing vs present-undefined
  vs present-null vs stale vs not-found).
- RPC layers are tested with Effect's in-process/test RPC tooling; any fake is built
  from the protocol spec.
- Remote server authorization has explicit tests for field-level denial, hidden
  existence, and partial entities.
- Remote adapter tests assert field pruning and batched loads against an in-process
  database; do not build a fake Drizzle query builder.
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
| `HtmlBuilder` subset variance (`Surface.view`) | High | **Resolved in Phase 0**: the builder is invariant; `Surface.view` uses a sound narrowing cast, with a Foldkit core seam as the durable option (decide before Phase 2). |
| `Remote.make` Model widening to `any` | High | Runtime registry + small scope brand over giant conditional unions; negative tests. |
| Message union identity is structural | Medium | Provide all structural safety; decide on a hidden union brand early. |
| Browser IndexedDB `KeyValueStore` missing | Medium | Resolve the platform dependency in Phase 12 before designing persistence. |
| `effect/unstable/rpc`/`persistence` churn | Medium | Pin rc.112; re-verify exact syntax in one isolated module; keep semantic types stable. |
| Scope (5 packages, rewrite Agent+Sync) | High | Phased, independently reversible; keep published packages working. |
| Concurrent sessions editing the tree | Medium | Stage only owned files; never `git add -A`; coordinate on `packages/surface/`. |
| Normalized store performance | Medium | Render optimization is a later interpreter; correctness first. |
| Drizzle external deps uninstalled/unproven | Medium | Pin and probe `drizzle-orm` / `effect-postgres` / `effect-schema` before Phase 14; the adapter is provisional. |
| ORM coupling / leaking SQL strategy | Medium | Relation metadata stays declarative; the adapter chooses strategy; abort the package if the value bar is not met. |
| Connection/pagination correctness (races, stable order) | High | Require a stable total order; explicit tests for insert/remove/pagination semantics. |
| Live replay/ordering correctness | High | Resume cursor + `ResumeUnavailable` + per-stream ordering are protocol from day one. |
| Fate-parity gaps (lists, rebasing, GC, races) | High | Treat as implementation work with dedicated phases/tests (§8.15), not as assumed. |

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
- **Connection** — a normalized ordered structure of entity references with explicit
  known boundaries, overlays, and live state.
- **Segment / Boundary** — a contiguous run of known edges with `Terminal`/`Cursor`/
  `Unknown` ends; boundaries make gaps explicit.
- **Edge identity** — how an edge is identified (default `EntityRef`; optional
  server `edgeKey`).
- **Connection overlay** — an optimistic insertion held outside the server-known
  segments until settled.
- **LiveCursor / LiveEvent / ResumeUnavailable** — the monotonic per-stream position,
  an ordered live fact, and the explicit "cannot resume" answer that forces a refetch.
- **Live policy** — per-connection `visible`/`boundary`/`invalidate`/`ignore` for how
  a live insertion interacts with pagination boundaries.

---

## 20. Immediate next step and open questions

**Next step:** Phases 0-13 and 15 are executed; Phase 14
(`foldkit-remote-drizzle`) is implemented but its Postgres acceptance is not run
(no database in CI). Remaining work: run the Phase 14 batched-relation and
pagination acceptance against a real Postgres and decide whether the package
ships or is dropped (open question 7); the Surface-based `Sync.make` on top of
`Sync.project` landed as `5d5a2d3` (it adds an explicit `initial` Model, which the
§10 sketch omitted); the durable contract landed as `5be48f3` as a method —
`TodoSync.journalContract()`, not `Sync.journalContract(TodoSync)`; `examples/sync`
now uses both, replacing its hand-written replica and journal contracts
(`0cb9d0e`); `packages/sync/README.md` and `CHANGELOG.md` document the new layer
(`717a28e`); the Foldkit runtime-binding gap and the proposed upstream hook are
documented in `docs/sync-runtime-binding.md` (`fdd9789`); the reference-based
selection from `packages/agent/DESIGN.md` started as `Surface.pick` over keyed,
owner-tagged Model references (`61eb87e`); `Surface.application`/`App.fields`
landed next (`8daf52b`); typed Message subsets landed as `Surface.messages`
(`fbf5368`); `Sync.forApplication` remains. Work through the review findings and
open questions below.
The builder-seam decision (open question 2) is answered: proceed with the sound
cast recorded in §15.

**Review findings.** Fixed in `de53997`: RemoteServer no longer reads/returns
fields the client did not request; `RemotePersistence.restore` clears a
wrong-shape snapshot instead of throwing; `classifyLive` accepts a non-1 first
cursor; `Remote.observe` emits an `onError` rather than a defect; the dead
`Remote.live` `policy` option is gone.

Fixed in `545bc62`, `98b2d1b`, `bfce617`, `0f864b0`, `08cfd01`:
`Connection.merge` ignores a zero-edge page and `dedupeConnection` splits a
segment at a dropped interior edge (no false adjacency); `reconcileMutation`
always clears `pending`; `Sync.project({})` types `Model` as `unknown`, not
`never`; `remote-drizzle` `whereIds` throws a clear error when the table has no
`id` column; `RemoteServer.FoldkitRemoteRead` filters untrusted field names with
`Object.hasOwn` into a null-prototype accumulator; `RemotePersistence.restore`
rejects a malformed *entry*, not just a malformed top level; `Query` identity
canonicalisation drops `undefined`-valued keys so an explicit `undefined`
optional matches an absent one; the read handler de-dups ids and intersects
authorization in sets rather than `Array.includes`.

Fixed in `1cbf55f`: the mutation idempotency ledger retains only the most recent
1024 settled request ids, so `MutationState.applied`/`failed` no longer grow
without bound. A retry older than the window would re-apply its entities.

Fixed in `138e589`: `Remote.select` assembles its fields and decodes them against
the Selection, returning `Failed`/`DecodeError` on a mismatch instead of
asserting into `Value`; the projection now carries a real `RemoteData` schema
rather than `Schema.Unknown`.

Fixed in `ca4f23f`: the Remote Model shape is a named `RemoteModel` that the
schema and the store accessors share, so `storeOf`/`Remote.select` no longer
cast an inline shape and a layout change is a compile error (`Remote.at` is
constrained, with a negative type case).

Fixed in `b3c86e3`: `Projection.struct` requires all entries to share one Root,
so mixing ModelRefs/Projections from different applications is a compile error
(negative type case, mutation-verified).

Fixed in `e3b5309`: `refreshConnection` clears a connection's stale mark, so
`live.invalidateConnection` is no longer a one-way flag. The refetching caller
invokes it when it adopts the fresh page.

Still open (all lower severity):

- **remote-drizzle does not check that the table-derived Schema agrees with the
  Remote Entity's `id` schema** (it now requires the `id` column to exist).
- **`handlers(server, principal)` binds one principal per handler set**, not per
  request; authentication middleware integration is deferred (§8.10).

Deliberate, not open:

- **`ModelRef.fromOptic` throws** when the optic does not focus. It is a
  total-focus escape hatch; absence is expressed by `.at`/`.index`, which return
  `Option`. Returning `Option` from every `ModelRef.get` would push absence into
  every projection read and every tree node.

**Open questions to resolve during or before Phase 1:**

1. In-repo `foldkit-surface` (recommended) vs an upstream Foldkit proposal.
2. **Answered in Phase 0: it does not.** `HtmlBuilder<M>` is invariant, so
   narrowing needs a cast or a Foldkit core seam. Phase 1 may proceed with the
   sound cast; the cast-vs-seam decision must be made before Phase 2
   (§15 Phase 0 results).
3. Do we attach a hidden union identity to Message constructors for nominal
   application isolation?
4. Which existing example(s) become the Phase 2 validation target?
5. Which browser `KeyValueStore` (IndexedDB) will Phase 12 use?
6. Do `ModelRef.at` on a record and `.index` on an array return `Option`, and where
   does absence flow (Schema vs value)?
7. Is `foldkit-remote-drizzle` worth shipping, or is a generic `RemoteServer.entity`
   Source short enough? (Decide after Phase 7, with a real Drizzle probe.)
8. Which Drizzle version/driver and which database for the first adapter?
9. Live ordering scope (per stream vs per connection/topic) and server cursor
   retention/expiry.
10. Do live events carry invalidations, direct normalized patches, or both — and
    under what conditions?
11. Default live insertion policy, and whether `edgeKey` is ever inferable rather
    than declared.
