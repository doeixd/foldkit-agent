# Server-derived state: `foldkit-surface` + `foldkit-remote`

A Foldkit Model holds all application state. Some of it the client owns — the
selected tab, a draft, the current route — and some of it is a **cache of server
data**. `foldkit-remote` keeps that cache normalized and inside the Model, so
server facts move through the same `update` as everything else. `foldkit-surface`
is the projection layer underneath it.

- [`foldkit-surface`](../packages/surface) — the observation boundary: pure Model
  projections, field references, and Message subsets.
- [`foldkit-remote`](../packages/remote) — the normalized entity store, the
  requirement planner, and the Remote Submodel.
- [`foldkit-remote-server`](../packages/remote-server) — the Sources and
  authorization that answer the client.
- [`foldkit-remote-drizzle`](../packages/remote-drizzle) — compiles selections and
  queries to Drizzle's typed query graph.

Remote is not a data-fetching hook. It answers one question:

> What server-derived information does this feature require, what do we already
> know, what is missing, and how should incoming facts change the normalized
> Model?

## The problem

Server data in a Foldkit app usually starts as ad-hoc fetching, and the usual
things go wrong:

- each view fetches what it renders, so two views fetch the same entity twice;
- loading and error state is re-invented per view;
- a mutation response patches some copies and misses others;
- a retry or double-submit applies the same change twice;
- a live update and a refetch race, and last-arrival wins;
- "is this field missing, or is it legitimately `null`?" is unknowable.

The fix is a **normalized cache**: entities stored once by identity, field
presence tracked explicitly, and every producer of new facts reconciled through
one pure reducer that lives in the Model.

## How they fit together

```text
        browser / device                         server / Node
  ┌──────────────────────────┐           ┌──────────────────────────┐
  │  Foldkit app (update)    │           │  foldkit-remote-server   │
  │      │                   │           │   Sources + authorize    │
  │      ▼                   │           │          │               │
  │  foldkit-remote          │  Effect   │  foldkit-remote-drizzle  │
  │  entities · plan · live  │◀──RPC────▶│  (SQL, optional)         │
  │  optimistic · mutations  │           │                          │
  └──────────────────────────┘           └──────────────────────────┘
                 ▲
                 │ projection + requirements
          foldkit-surface
        Projection · field refs · subsets
```

The client half is a Foldkit Submodel. `Remote.make` returns `Model`, `initial`,
`Message`, `update`, and the Effect RPC group; the application embeds `Data.Model`
in its Model and reduces `RemoteMessage`s with `Data.update`.

The server half compiles Sources into the `RemoteRpc` handlers. Transport is
Effect RPC, so HTTP, WebSocket, worker, or in-process is an Effect layer choice;
Remote does not define a transport.

## What is normalized

An entity is stored once, keyed by its name and id, regardless of how many views
read it. A connection stores **references** with explicit boundaries.

```text
Project:p1            name PRESENT   status STALE   owner PRESENT → User:u7
User:u7               name PRESENT   avatarUrl MISSING
ProjectsByOwner(u7)   Project:p9  Project:p7  Project:p4  [gap]  Project:p1
```

- **Presence is separate from values.** Missing, present `undefined`, present
  `null`, stale, and not-found are distinct, and presence is never inferred from
  `value === undefined`.
- **Tombstones make absence cacheable.** A not-found entity is not refetched
  forever; a later write clears the tombstone.
- **A connection is an ordered structure with boundaries.** If page 1 is
  `A B C D` and page 3 is `I J K L`, a flat array would falsely claim they are
  adjacent. Segments with explicit boundaries make the unloaded middle an honest
  gap.

## Requirements and observation

A Surface's projection carries its remote **requirements** — entity, id, fields,
and a pagination window per relation — as plain data. Reading is pure; it
performs no I/O.

The planner diffs requirements against the store and returns only the missing or
stale fields. It is deterministic and takes `now` as input (`PlanFreshness`)
rather than reading the clock, so the same store and requirements produce the same
plan.

Fetching is a Foldkit Subscription derived from the Surface:

```ts
const subscriptions = (model: Model) => [
  Remote.observe(AppRemote, ProjectPage, { projectId: model.route.projectId }, message =>
    GotRemote({ message }),
  ),
]
```

`Remote.observe` plans, fetches only the missing fields through `RemoteClient`, and
emits a `RemoteMessage`. A fully-known Surface emits nothing. SSR, route/hover
prefetch, and tests reuse the same plan through `Remote.prefetch`.

In the view, a remote field is a `RemoteData`. `Remote.select` produces
`Initial` until its selected fields are present, `Ready` once they are, `Failed`
if the server data does not decode, and `NotFound` for a tombstone. `Loading` and
`Refreshing` exist for a caller that tracks a request lifecycle explicitly. There
is no hidden suspense; the states are explicit.

## Mutations and live data

A mutation flows through the ordinary Foldkit path — UI Message → `update` →
Command → `Remote.mutate` — and returns to the Model as a `RemoteMessage`:

```text
UI → ClickedRename → update → Command → Remote.mutate ──RPC──▶ server
                                                                  │
        Remote.update ◀── MutationSucceeded { output, entities } ◀┘
```

The result carries the typed `Output` **and** normalized entity patches. Settling
is idempotent per `requestId`, so a transport retry cannot apply the same change
twice. The application could equally reduce the patches by hand; `Remote.mutateInto`
is the one-step form.

Optimistic changes are ordered **layers** over the base store, not inverse
patches: the visible store is recomputed as base + layers, success merges the
server patch and removes the layer, and failure removes the layer. Overlapping
layers therefore rebase for free.

Live data is an Effect streaming RPC. Each stream has a monotonic cursor:
duplicates are ignored, and an event **ahead** of the cursor is a gap — it is not
applied, and the stream is recorded so the host can resync rather than silently
miss facts. Entity events update the store; connection events change membership
and ordering.

## One owner per datum

A logical piece of state should have one authoritative owner. Surface composes
the owners; it does not erase the boundary.

| State | Owner |
| --- | --- |
| Current route, selected item, transient errors | the local Model, plain `update` |
| Server-derived, disposable cache | `foldkit-remote` |
| Client-owned replicated state, offline writes, convergence | `foldkit-sync` |

Reaching for the wrong owner is the usual source of double-fetch bugs: a
collaborative draft belongs to Sync, an analytics summary to Remote, and the
currently selected project to the local Model. A Surface may project all three at
once.

## Persistence and recovery

`RemotePersistence.save`/`restore` snapshot the entity store through Effect's
`KeyValueStore`. The cache is server-derived and **disposable**: a version
mismatch or malformed snapshot is removed and the planner refetches. This is the
opposite of Sync's preserve-and-recover policy, because Remote holds no unsent
user edits; there is nothing to lose.

## When not to use Remote

- **Local-only state.** Use the Model and `update`; there is no server truth to
  cache.
- **Offline writes and convergence.** Use [`foldkit-sync`](./replication.md); it
  owns client-authored operations and orders them through a durable log.
- **Request-level caching of one expensive endpoint.** Effect's `PersistedCache`
  fits (`Request → Result`); Remote is `Entity + Field → Value` and normalizes
  across requests.
- **Peer-to-peer or CRDT replication.** Out of scope.
- **A general-purpose database.** Remote holds an application-facing cache; it is
  not a query engine. `foldkit-remote-drizzle` compiles the selection and query
  it already understands into SQL, and no further.

## Current limits

- `examples/remote` is a worked `make → at → select → plan → prefetch → render →
  mutate` trace, asserted line by line. The test suites remain the exhaustive
  executable specification: `pnpm exec vitest run packages/remote/test
  packages/remote-server/test`.
- Live **connection** events are represented on the wire: `LiveChange` carries
  entity patches and deletes plus connection insert/remove/invalidate changes,
  and `RemoteServer.live` streams them.
- `Query` descriptors are consumed by `Remote.query`/`Remote.queryMessage` and by
  `foldkit-remote-drizzle`.
- There is no request-level in-flight dedupe: the planner returns missing fields
  and the Subscription re-runs when the plan changes.

## See the APIs

The package READMEs document the full surface:
[`foldkit-surface`](../packages/surface),
[`foldkit-remote`](../packages/remote),
[`foldkit-remote-server`](../packages/remote-server), and
[`foldkit-remote-drizzle`](../packages/remote-drizzle). The worked trace is in
[`examples/remote`](../examples/remote). The design rationale is in
[Revision Plan §8](../REVISION_PLAN.md#8-remote).
