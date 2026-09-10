# `foldkit-durable`

A durable, ordered operation log with a snapshot and cursor per key, backed by
[`effect/unstable/sql`](https://effect.website) through
`@effect/sql-sqlite-node`. Storage and ordering only; application semantics stay
in the `reduce` the caller supplies.

It is the **server half** of [replicated Foldkit state](https://github.com/doeixd/foldkit-plus/blob/main/docs/replication.md).
Reach for it when a server must sequence operations from many clients, replay or
compact them, and retain effect outcomes; `foldkit-sync` is the client
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
- **A durable effect ledger.** `runEffect(key, run)` reuses recorded successes
  and shares concurrent calls within one journal instance.
- **Migrations.** The tables are created or upgraded by a transactional
  `user_version` migration, so an existing database is upgraded in place and an
  interrupted run is safe to repeat.
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
- A successful effect record is reused across restarts without invoking `run`.
  Concurrent calls with the same key share a run within one journal instance.
  These guarantees do not establish exactly-once execution at an external provider.

## Effect recovery

The external action and the journal's success record are separate commits.
If the process exits between them, the action may have happened even though
the ledger still says `pending`. A `failed` record can also be uncertain: a
provider may have accepted a request before the response or local save failed.
Calling `runEffect` again retries both `pending` and `failed` records. It does
not decide whether retrying is safe, and it does not restart work automatically.

| Durable record | What recovery can conclude | Application policy |
| --- | --- | --- |
| None | No run was recorded for this key. A committed operation may still require work. | Discover the intent from retained application data, then start it. |
| `pending` or `failed` | The external outcome may be unknown. | Retry only with provider idempotency or proof that repeating is safe; otherwise reconcile with the provider or require manual resolution. |
| `succeeded` | The result was recorded. | Call `runEffect` to reuse it without contacting the provider. |

Choose the identity before executing the action. The effect ledger's keys are
global to the database, so include the document as well as the operation and
a stable semantic name. For example, with an application-supplied provider:

```ts
const key = JSON.stringify(['orders', operation.opId, 'send-confirmation:v1'])
yield* journal.runEffect(
  key,
  Effect.tryPromise(() => provider.sendConfirmation({
    orderId: operation.orderId,
    idempotencyKey: key,
  })),
)
```

The provider must durably associate that key with the action and its result.
Keep the key and request payload stable across retries, and account for the
provider's idempotency retention period. An expired provider key is an uncertain
outcome, not permission to repeat a non-idempotent action. Without provider
support or a way to query the outcome, an email sent just before a crash can
be sent twice; the journal cannot rule that out.

Do not derive identities from Command array positions: reordering Commands
would assign an old result to a different action. Preserve semantic names for
existing intents across application upgrades. A new name denotes new work;
it must not be used merely to retry an old intent. Multiple effects of the
same kind need an additional stable identity, such as the recipient id.

### Discovering unfinished work

`journal.effect(key)` is a lookup, not an intent queue. Recording `pending`
happens when `runEffect` starts, separately from `append`. Recovery must also
find operations committed before settlement started:

1. For each application-owned document, read operations after an application
   recovery cursor and derive their stable effect intents.
2. Inspect each intent's record and apply the policy above. Advance the recovery
   cursor only once the operation's intents are resolved. If the cursor is lost,
   rescanning is safe for recorded successes and provider-idempotent actions.
3. Keep unresolved operation payloads available: do not compact past the recovery
   cursor. Alternatively, retain intents and their identities in application
   snapshot state through the same reducer/append transaction, and discover them
   from `load` after compaction. Re-derive old intents with their original semantics.

The application owns document enumeration, the recovery cursor or snapshot
intents, and scheduling recovery on startup. A subscription is only a wake-up
signal; it cannot recover missed commits by itself. There is no atomic
append-and-enqueue API or built-in recovery worker today.

### Execution ownership

The in-flight registry belongs to one `makeJournal` instance. Two journal
handles or processes can both execute the same key; writing `pending` is not
an exclusive claim. Route execution to one owner for the database. Multi-owner
execution requires a persistent claim/lease protocol with fencing and a recovery
policy, which this package does not supply. Such ownership still cannot close
the gap between external success and recording it locally.

Process-crash tests in `test/effectRecovery.test.ts` exercise exits after append,
before provider work, after provider success, and after recording success but
before acknowledgement. They use a separate SQLite provider emulator with
durable idempotency receipts and also demonstrate the duplicate without them.
These tests cover process termination, not machine power loss.

## Retention

Compaction drops payloads, not identities. Two tables grow for the life of the
database:

- **Operation identities.** One row per distinct `opId`, kept after its payload
  is compacted, so a retransmission is acknowledged instead of reapplied.
- **Effect records.** One row per settled effect key, kept so a replay reuses the
  result without invoking `run`.

Neither is garbage-collected, so storage grows with the number of distinct
operations and effects rather than with the payload size you compact away.

Old retries are therefore safe: a replica that reconnects below the compaction
floor still has its operation acknowledged from the identity row, and its effect
is not repeated. That holds for as long as the row exists.

The package does not supply a garbage collector. To bound storage an application
rotates or recreates the database. After that, a retry whose identity row is gone
is indistinguishable from new work, so the application must refuse it rather than
reapply it — for example, reject an operation whose `baseCursor` is below the
floor the application retains, or keep a per-document watermark and refuse
anything older. State the retained window and the refusal explicitly; do not let
a rotated journal silently turn an old retry into a new commit.

## Limits

- SQLite through `@effect/sql-sqlite-node` is the only adapter today, and it
  needs Node 22 (`node:sqlite`). The storage contract is `SqlClient`, so a
  Postgres adapter is a driver swap.
- The SQL module is under `unstable` in the pinned Effect release candidate.
- The `[key, op_id]` and `[key, sequence]` uniqueness is enforced by the table
  schema; a server-authoritative deployment is still a single writer per
  database file.
