# `foldkit-durable`

A durable, ordered operation log with a snapshot and cursor per key, backed by
[`effect/unstable/sql`](https://effect.website) through
`@effect/sql-sqlite-node`. Storage and ordering only; application semantics stay
in the `reduce` the caller supplies.

It is the **server half** of [replicated Foldkit state](https://github.com/doeixd/foldkit-plus/blob/main/docs/replication.md).
Reach for it when a server must sequence operations from many clients, replay or
compact them, and run side effects exactly once; `foldkit-sync` is the client
half. The [guide](https://github.com/doeixd/foldkit-plus/blob/main/docs/replication.md) covers the mental model and when not
to use it.

```ts
import { Config, Effect } from 'effect'
import { actorId, documentId, makeJournal, opId } from 'foldkit-durable'

const run = Effect.gen(function* () {
  const journal = yield* makeJournal({
    file: Config.succeed('journal.sqlite'),
    operation: { encode: operation => operation, decode: readOperation },
    snapshot: { encode: snapshot => snapshot, decode: readSnapshot },
    empty: () => ({ todos: [] }),
    reduce: (snapshot, operation) => applyTodo(snapshot, operation),
    opId: operation => opId(operation.opId),
    actorId: principal => actorId(principal.actorId),
  })

  yield* journal.append(documentId('todos'), operation, principal)
  const rows = yield* journal.read(documentId('todos'), 0)
  return rows
}).pipe(Effect.scoped)

await Effect.runPromise(run)
```

`makeJournal` is scoped: the SQLite connection is released when the scope
closes. `file` accepts a literal or a `Config.Config<string>`, so the path can
come from the environment. Failures are `Schema.TaggedError`s
(`JournalError`, `InvalidOperationError`, `OperationRejectedError`,
`IdentityConflictError`, `InvalidCursorError`, `InvalidCompactionError`), so
`Effect.catchTag` narrows them.

## The journal as a service

`makeJournalLayer` provides the journal through `Effect.provide`, and
`JournalService` reads it back:

```ts
import { Effect } from 'effect'
import { JournalService, makeJournalLayer } from 'foldkit-durable'

const program = Effect.gen(function* () {
  const journal = yield* JournalService<Operation, Snapshot, Principal>()
  return yield* journal.load(documentId('todos'))
}).pipe(Effect.provide(makeJournalLayer(options)))
```

## What it owns

- **Atomic, idempotent append.** A repeated `opId` is answered from the log; a
  reuse with a different payload or actor is an `IdentityConflictError`.
- **A snapshot and cursor per key**, written together in one transaction.
- **Compaction.** Payloads below a floor are dropped without changing the state
  a replay of the compacted prefix would produce; identity rows remain.
- **A change stream.** `journal.subscribe` is a `Stream.Stream<string>` of the
  keys a commit changed. A subscriber never fails or slows a commit.
- **A durable effect ledger.** `runEffect(key, run)` runs an externally visible
  effect at most once per key and records the outcome durably, so a replay or
  restart cannot duplicate it.
- **Migrations.** The tables are created or upgraded by a transactional
  `user_version` migration, so an existing database is upgraded in place.
- **Metrics.** `journalMetrics` counts appends, compactions, owner effect runs,
  and coalesced effect runs.
- **Branded identities.** `DocumentId`, `OpId`, and `ActorId` are
  `Schema.brand`s with `documentId` / `opId` / `actorId` decoders, so they cannot
  be swapped.

## Guarantees

- Append is atomic.
- A repeated `opId` is idempotent, including after compaction; reuse with a
  different payload or actor is an identity conflict.
- Committed order is stable and gap-free.
- The snapshot and cursor are written together.
- Compaction drops committed payloads but never changes the state a replay of
  the compacted prefix would produce.
- A subscriber's failure never fails a commit.
- `runEffect(key, run)` runs an externally visible effect at most once per key
  and records the outcome durably; a concurrent call shares the run in flight,
  and a failed run is left recorded so it may be retried. Key it by the
  operation that caused it, e.g. `opId + "/command/" + index`.

## Limits

- SQLite through `@effect/sql-sqlite-node` is the only adapter today, and it
  needs Node 22 (`node:sqlite`). The storage contract is `SqlClient`, so a
  Postgres adapter is a driver swap.
- The SQL module is under `unstable` in the pinned Effect release candidate.
- The `[key, op_id]` and `[key, sequence]` uniqueness is enforced by the table
  schema; a server-authoritative deployment is still a single writer per
  database file.
