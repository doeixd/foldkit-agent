# `foldkit-remote-drizzle` — remaining decisions

**Status:** design analysis, no implementation. Tracks four decisions that are
not "missing architecture" but genuine design choices, each with real cost and
cross-package blast radius. Grounded in the code as of `4c12d40`.

The port itself is done: cursor kernel, required-column projection, entity
reads, keyset queries, `one`/`many`/`manyToMany` loading with ordering and
filtering, mutation normalization, a driver-agnostic `DrizzleDatabase` service,
and client-selected nested pagination (`Selection.connection`, `RefPage`).

This document gives, for each decision, the current behaviour, what it costs,
the options, their implications, and a recommendation. A summary table and a
suggested sequence are at the end.

---

## How to read this

- **Server** means `foldkit-remote-drizzle` + `foldkit-remote-server`.
- **Client model** means `foldkit-remote` (`Selection`, `plan`, `EntityStore`,
  `Connection`, `RemoteModel`).
- "Blast radius" counts packages whose public types or serialized shapes change.
- Recommendations are opinions; the point of the document is that each is a
  choice, not an obvious next commit.

---

## D1 — Relation cursoring and connection accumulation

**Status: server cursor (A2) implemented in `ce7dec6`.** `last` pages per
parent; `after`/`before` work for a single parent. Client accumulation (B2/B3/B4)
remains open.

### Current behaviour

`Selection.connection(Target, { first })` produces a `RefPage` value
(`{ refs, hasNext, hasPrevious }`) per parent. The adapter rejects `last`,
`after`, and `before` with a typed error. The field value is one page; a later
read replaces it. There is no client-side merge, and `RemoteModel.connections`
is still a `Record<string, unknown>` stub.

So today the window is effectively a **cap with a hint**: the client is told
`hasNext` but cannot ask for page two.

### What has to be decided

1. **Cursor mechanics on the server.** Which windows are supported, and how the
   cursor is represented.
2. **Client accumulation.** Whether the library merges pages, or the app does.

### Per-parent windows do not survive batching

This is the crux. A `ReadRequest` is per `(entity, id)` and carries its own
`windows`. `RemoteServer` groups requests **by entity**, merging windows for the
same field (later wins). So a batched read of 50 projects collapses all their
`comments` windows into one. A per-parent cursor is therefore meaningful only
when the read is for a **single parent**; otherwise it is ambiguous.

### Options

**Cursor mechanics**

| # | Option | Implications |
| --- | --- | --- |
| A1 | Keep first-only (status quo) | Zero cost. No "load more". The window is a cap. |
| A2 | Cursor only for a single-parent read (`ids.length === 1`); multiple parents with a cursor fail typed | Reuses the query source's id-cursor + tuple re-read. Bounded adapter change. Correct for the common "view one parent's relation" case. Fails loudly otherwise. |
| A3 | Per-parent windows through the protocol | `RemoteServer` grouping must stop merging windows per entity and thread a per-id window map to the source; the source's batched relation load must split. Real protocol change, for a rare case. |

**Client accumulation**

| # | Option | Implications |
| --- | --- | --- |
| B1 | None (status quo) | The field holds one page. "Load more" impossible without app code. |
| B2 | App-level accumulation | The app reads `hasNext`, requests `after`, concatenates refs, writes the field. No core change; every app reimplements ordering/dedupe. |
| B3 | A `Connection` of refs as the field value; merge on write | `connection.ts` already has `Segment`/`Boundary`/`merge`. Needs: a `Connection` schema, a write path that **merges** rather than replaces, and a cursor carried on the page/boundary. Medium-large; touches store, persistence, `Remote.select`. |
| B4 | A shared connection store keyed by connection identity (`RemoteModel.connections`) | The brainstorm's model; unifies nested relation connections and top-level queries. Largest; but the place the architecture is clearly heading. |

**Cursor encoding**

| # | Option | Implications |
| --- | --- | --- |
| C1 | Cursor = row id; server re-reads the ordering tuple | Already used by `query`. Extra query per cursor page; works for any column type. A missing cursor row currently fails the query. |
| C2 | Cursor = encoded ordering tuple (e.g. base64 JSON) | One query, no missing-row failure, no re-read. Needs a typed codec for dates/numerics/null and a stable total order; larger cursors. |

### Recommendation

- **Server:** A2 now. It completes the adapter for the realistic case at a
  fraction of A3's cost, and A3 can come later if batching many paginated
  relations is ever needed.
- **Client:** B2 to start (ship the server capability, let apps accumulate),
  then B3 as the library-grade answer. B4 is the long-term shape but should be
  designed together with top-level query connections, not for relation
  pagination alone.
- **Encoding:** stay on C1 until C2 is needed; the re-read is one cheap indexed
  lookup and keeps cursor types trivial.

### Non-obvious consequences

- A2 + B2 means the library owns correctness of a *single page* and the app owns
  ordering across pages. That is a support burden; if it bites, jump to B3.
- B3/B4 make `plan` see a `Connection` field as present after page one and stop,
  which is correct only if the cursor is part of the connection identity — the
  same problem as D2, below.

---

## D2 — Window-change refetch

**Status: implemented in `8bdebdd`.** The analysis below is the reasoning that
led to it.

### Current behaviour

`plan` calls `missingFields(store, key, fields)`, which returns a field unless
it is present, not stale, and the entity is not tombstoned. It compares nothing
about **how** the field was fetched.

Consequence: a field fetched with `comments: { first: 10 }` is "known"; a later
selection of `{ first: 20 }` does not refetch. A "load more by widening the
window" is silently ignored. This is a correctness trap in the feature shipped
in `7dc8196`.

### Options

| # | Option | Implications |
| --- | --- | --- |
| A1 | Document only | Cheap, but a silent wrong result for a plausible pattern. |
| A2 | Record the applied window per field; a differing request is missing | The correct fix. Needs `EntityEntry.windows`, a persistence version bump, a `writeEntity` parameter, and a read-write path that records the window. |
| A3 | Encode the window in the stored field key | Rejected: `Remote.select` reads by plain field name; the key leaks into everything. |
| A4 | Always treat a windowed field as stale when a window is requested | Rejected: refetches forever. |
| A5 | Store the window inside the page value and make `missingFields` inspect it | Rejected: couples the pure store diff to a value shape. |

### Recommendation

**A2.** It is the only option that is both correct and local. Sketch:

```ts
// store.ts
interface EntityEntry {
  // …
  /** Canonical key of the window each present field was fetched with; "" = none. */
  readonly windows: Readonly<Record<string, string>>
}

writeEntity(store, key, values, now = 0, windows?: Readonly<Record<string, string>>)

missingFields(store, key, fields, windows?) // a differing window key counts as missing
```

The read result does not carry the window, but the planner does. Add one helper
so every path records it identically:

```ts
Remote.writeRead(store, requests: readonly Requirement[], result: ReadBatchResult): EntityStore
```

and make `prefetch`/`observe` use it instead of the ad-hoc
`result.entities.reduce(writeEntity)`. That also centralizes the normalized
write. Mutation and optimistic writes pass no window, clearing the field's
window because its value changed — correct.

### Non-obvious consequences

- **Persistence version.** `REMOTE_CACHE_VERSION` bumps to 2; an old snapshot is
  discarded and refetched. That is the documented, cheap policy for a
  server-derived cache.
- **`observe` today.** The subscription emits only `ReadBatchResult`; the app
  writes it and has no windows. `writeRead` fixes this only if the app calls it
  with the plan's requests. Either the emitted Message carries the requests, or
  the app recomputes the plan (it already has the dependencies). This is a small
  API decision hiding inside the fix.
- **Memory.** One short string per present field; negligible.

---

## D3 — Relation authorization

### Current behaviour

`authorize(principal, fields)` runs on the **owning** entity source and gates
which fields are read. A permitted relation field is loaded and its target refs
are returned. The **target** entity's `authorize` is not consulted. Scalar
target fields are not returned unless the client separately selects them (and
then the target source's `authorize` applies).

So the exposure is the **existence and id of referenced rows**, not their data.

### Options

| # | Option | Implications |
| --- | --- | --- |
| A1 | Document: ids are not sensitive | Matches Relay/Fate norms. Zero cost. Wrong if a target's existence itself is confidential. |
| A2 | Principal-aware relation `where` on the binding | Row-level scoping that reuses machinery the adapter already has. `where: (principal) => SQL \| undefined`, evaluated per read. Small, sound. Does not gate "can see the relation at all". |
| A3 | Per-relation boolean predicate (field-level gate) | Straightforward, but a denied relation must be omitted (client loops forever on a missing field) or emitted as null/empty (a false "no relation"). Both are poor. |
| A4 | Server-level policy: `RemoteServer` consults the target source | The coherent home, but `RemoteServer` has no relation metadata; the adapter would have to register relation→target with the server. More plumbing. |
| A5 | App excludes the field in `authorize` | Already possible, no code. The honest default for "must not reveal". |

### Recommendation

- **A1 + A5** now: document the exposure, and make "relation not visible" an
  `authorize` decision (already supported).
- **A2** if row-level scoping is needed (e.g. only visible comments): it is a
  small change and reuses `where`. Upgrade its signature from a constant `SQL`
  to `SQL | ((principal) => SQL | undefined)`.
- **A3 is an anti-pattern** unless the deny behaviour is defined (omit vs
  empty); do not add it casually.
- **A4** only if relation metadata is lifted into `RemoteServer`, which is a
  larger architectural move and should be justified by more than this.

### Non-obvious consequences

- A2 leaks nothing beyond what `where` can express, but it runs per read; keep
  it cheap and synchronous.
- If relation metadata ever reaches `RemoteServer` (for live fan-out, DevTools,
  or A4), that is the moment to unify relation policy there.

---

## D4 — Computed and aggregate fields

### Current behaviour

Not supported. `Entity` fields map to columns or declared relations.

### Options

| # | Option | Implications |
| --- | --- | --- |
| A1 | Defer (the brainstorm's stance) | Zero cost. Computed fields are not required for Fate-like normalized fetching. |
| A2 | Adapter-level computed on the binding | `computed: { commentCount: { relation, where? } }`; the source runs a grouped `COUNT(*)` over the child FK and attaches numbers to values. No new core concept (the field is just a number in the Entity schema). Bounded, testable. Counts only unless generalized. |
| A3 | First-class `Entity.computed` in core | Composes with Selection/DevTools/agents; most coherent. Real core design: schema, planning, dependencies, and what "missing" means for a computed field. |

### Recommendation

**A1** until an application needs it; then **A2** for counts, and only
generalize to **A3** if computed values must compose through selections.

### Non-obvious consequences

- A2's computed value is fetched with the entity, so `plan` treats it like any
  field; a computed field's inputs (the child relation) are hidden compiler
  dependencies, exactly the "required columns" idea already implemented for
  keyset columns.
- A3 interacts with D2 (a computed value has no window) and with D1 (a computed
  count over a paginated relation is a different question than the page).

---

## Cross-cutting

### Nullable ordered columns

`keysetWhere` emits `gt(col, null)` when a cursor value is null, which is
invalid SQL, and it does not encode Postgres NULL ordering (NULLs last for ASC,
first for DESC). Any cursor option (C1 or C2) needs NULL-aware branches:

```
(col IS NOT NULL AND col > $x) OR (col IS NULL)   -- ASC, ascending traversal
```

This is independent of D1–D4 and should be fixed before cursoring nullable
columns ships, in both `query` and relations.

### SQL window optimization

`ROW_NUMBER() OVER (PARTITION BY fk ORDER BY …)` fetches every parent's first N
in one query instead of N. It needs the `DrizzleStatement` contract to accept
expression/window columns. Deferred; the per-parent fallback is correct, and the
optimization should be benchmark-driven.

### One connection model

Nested relation connections and top-level `Query` connections should share the
same `Connection` type and, ideally, the same store slot. `RemoteModel.connections`
is a stub today; B4 is the moment to define it. Until then, top-level connection
state lives wherever the app put it, which is a known asymmetry.

### Cursor strategy is global

C1 vs C2 should be decided once for `query` and relations together; two cursor
dialects in one client is a bug factory.

---

## Suggested sequence

1. **D2 (window-change refetch)** — done (`8bdebdd`): `EntityEntry.windows`,
   `Remote.writeRead`, and persistence version 2. It established the shared
   write path D1 wants.
2. **D1 server cursor (A2)** — done (`ce7dec6`): `last` per parent and
   `after`/`before` for a single parent, reusing the query source's id cursor.
3. **Nullable ordering fix** — required before cursoring nullable columns.
4. **D1 client accumulation (B2 -> B3, B4 long-term)** — the library-grade
   connection; design B4 together with top-level queries.
5. **D3 (A2 row-level relation `where`)** — small, when an app needs it.
6. **D4** — only when an app needs computed values.
7. **SQL window optimization** — benchmark-driven.

## Decision summary

| Decision | Recommended option | Effort | Blast radius | Risk if deferred |
| --- | --- | --- | --- | --- |
| D1 cursor | A2 single-parent, C1 id cursor | M | adapter + server | Resolved server-side (`ce7dec6`); batched relations are first/last only |
| D1 accumulation | B2 now, B3 next, B4 long-term | L | client model | Apps own merge correctness |
| D2 window change | A2 record applied window | M | store + persistence + read path | Resolved (`8bdebdd`) |
| D3 relation authz | A1/A5 now, A2 row-level later | S–M | adapter (A2) | Reveals target ids |
| D4 computed | A1 defer, A2 counts later | S–M | adapter | No aggregates |
| Nullable ordering | Fix before nullable cursors | S | cursor kernel | Invalid SQL on a null cursor |
| Window functions | Defer, benchmark-driven | L | database contract | N queries for N parents |

## Open questions

- Does a paginated relation ever need per-parent cursors in a **batched** read,
  or is a single-parent view always the case? **Resolved: A2.** A cursor needs a
  single parent; A3 (a per-parent window protocol) remains available if a batched
  per-parent cursor is ever needed.
- Should `observe`'s Message carry the plan's requests so `writeRead` can record
  windows, or should the app recompute them?
- Is `RemoteModel.connections` one slot for nested and top-level connections, or
  two? (Decides B3 vs B4.)
- Are target ids confidential in the intended deployments? (Decides whether D3
  needs A2/A4 at all.)
