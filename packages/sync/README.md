# `foldkit-sync`

A local-first replica of a shared Foldkit projection. The application's Message
union and `update` stay authoritative; sync wraps them rather than introducing a
second reducer.

It is the **client half** of [replicated Foldkit state](https://github.com/doeixd/foldkit-plus/blob/main/docs/replication.md).
Reach for it when clients must keep working offline and converge later, with
`foldkit-durable` (or any server that orders operations) as the authority. The
[guide](https://github.com/doeixd/foldkit-plus/blob/main/docs/replication.md) covers the mental model and when not to use
it.

## Quick start

`Sync.forApplication` is the Foldkit-facing layer. From one
`Surface.application` and a writable projection it derives the shared schema, the
durable Message subset, the initial snapshot, and replay, and exposes a read-only
Surface over the same projection. The application's `update` stays the only
reducer.

```ts
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { documentId, forApplication } from 'foldkit-sync'

const Model = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  SelectedTodo: { id: Schema.String },
})

// `update` is the application's ordinary transition.
const App = Surface.application({
  Model,
  Message,
  initial: { todos: [], selectedTodoId: null },
  update,
})

const Todos = Surface.pick(App.fields.todos)
const TodoChanges = Surface.messages(App, [Message.CreatedTodo, Message.RenamedTodo])

const TodoSync = forApplication(App, {
  documentId: documentId('todos'),
  shared: Todos, // the shared codec, read, and write
  durable: TodoChanges, // the durable subset
})
```

Only `todos` is replicated; `selectedTodoId` stays local. The derived `replay`
installs the shared slice into the application's initial Model, applies the
durable Message through `update`, and reads the shared slice back — the
state-only, deterministic subset. `Sync.make` below takes a custom `replay` when
an application needs one.

On the server, the same contract produces the journal's codecs and reducer, so
neither is written twice:

```ts
import { makeJournal } from 'foldkit-durable'

const journal = yield* makeJournal({
  ...TodoSync.journalContract(), // operation/snapshot codecs, empty, reduce
  file: 'todos.sqlite',
  opId: operation => operation.opId,
  actorId: principal => principal.actorId,
})
```

### Lower level

`Sync.forApplication` and `Sync.make` compile down to `defineSync`, the protocol
primitive. Use `defineSync` directly when there is no Foldkit application to
derive the contract from — a non-Foldkit client, or a hand-written projection.

```ts
import { Effect } from 'effect'
import { defineSync, indexedDb, layerFromPromise, replicaId } from 'foldkit-sync'

const Sync = defineSync({ ... })

const replica = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* indexedDb('todos-tab-1')
    return yield* Sync.openReplica(replicaId('tab-1'), storage)
  }),
)
await Effect.runPromise(
  replica.submit(Message.CreatedTodo({ id: crypto.randomUUID(), title: 'Milk' })),
)
await Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport)))

const shared = Effect.runSync(replica.shared)
```

## What it owns

- The Foldkit-facing contract (`Sync.forApplication`, or `Sync.make` with a custom
  `replay`): derives the shared projection, the durable Message subset, the
  initial snapshot, and the journal contract from the application, so none is
  declared twice. `Surface.pick`/`Sync.project` build the writable projection;
  `TodoSync.journalContract()` builds the durable codecs and reducer.
- The operation envelope: `replicaId:localSequence` identity, `baseCursor`, and
  protocol/schema versions.
- A persisted outbox and optimistic projection: a durable Message is visible
  immediately and rebased onto the authoritative order.
- Reconciliation: committed operations are replayed in order, acknowledged or
  refused pending entries are dropped, and a checkpoint replaces the compacted
  prefix. `replica.start` is the exchange loop: fork it to exchange once and then
  after every `submit`, with a transport failure recorded in `status.lastError`
  and retried on the next wake, so the application does not hand-roll it.
- A redacted status (`replica.status`): the pending count, the cursor, the last
  exchange failure, and the operations the server refused — enough for a UI to
  explain and recover without exposing Messages or the Model.
- Strict decoding: an operation is always validated with the application's
  Message schema, and a Message the contract does not call durable is refused.
- Branded positions: `Sequence` (a committed document position) and
  `LocalSequence` (a replica's own 1-based counter) cannot be confused, so a
  client counter is never passed where a committed position is expected.
- Presence (`createPresence`): an ephemeral, TTL'd peer registry, deliberately
  outside the durable log. A peer that stops refreshing is dropped, not
  replayed. It is an Effect driven by the `Clock` (so a `TestClock` makes the
  TTL deterministic), peers live in a `Ref`, and the channel is a `PubSub`.
  Every value is decoded through the required `decodeValue` before it is stored,
  so a hostile peer cannot inject a value your `Update` type does not describe.
  Presence can travel over a socket — `socketPresenceChannel` on the client and
  `servePresence` fanning through a `createPresenceHub` on the server — or
  in-process via `loopbackPresenceChannel`. `presence.changes` is a `Stream` of
  the live peers, re-emitted on every change, alongside the `subscribe` callback.
- The transport seam (`Transport`): an Effect service with a loopback layer, a
  bridge to and from the promise client the replica speaks, and a WebSocket
  client layer. The socket reconnects on an exponential, jittered backoff and
  re-sends queued and in-flight frames with their original ids, so a lost reply
  is answered rather than dropped; retries (`maxRetries`) and the queue
  (`maxQueue`) are bounded, and `serveSocket` is the server side of a
  connection. A refusal is an exchange result; only a wire failure is a
  `TransportError`.

## Limits

- IndexedDB is the only storage adapter.
- It assumes an authoritative, single-writer-per-document server that orders
  operations; there is no peer-to-peer replication. Applications can opt individual
  fields into the specialized merge helper below.
- Binding the socket transport and presence server to a platform WebSocket
  server is left to the application; the sync example shows a `ws` one for the
  transport (presence over `ws` is not wired there yet).

## Last-writer-wins fields (M8, experimental)

Use `lwwRegister` when a field's winner should depend on a write's logical time
instead of the order offline clients reconnect. It returns a schema and a pure
`merge` function to call inside the application's existing `update`:

```ts
import { Schema } from 'effect'
import { lwwRegister } from 'foldkit-sync'

const Title = lwwRegister(Schema.String)
const Shared = Schema.Struct({ title: Title.schema })
const Renamed = Schema.Struct({ _tag: Schema.Literal('Renamed'), title: Title.schema })

const update = (model: typeof Shared.Type, message: typeof Renamed.Type) => ({
  ...model,
  title: Title.merge(model.title, message.title),
})

const message: typeof Renamed.Type = {
  _tag: 'Renamed',
  title: { stamp: { counter: 1, replicaId: 'tab-a' }, value: 'Milk' },
}
```

Higher `counter` wins; equal counters use lexicographic UTF-16 `replicaId`
order, independent of locale. This is logical ordering, not wall-clock time.
The rule follows the total-order register model described in
[Replicated Data Types: Specification, Verification, Optimality](https://www.microsoft.com/en-us/research/publication/replicated-data-types-specification-verification-optimality/).

Allocate stamps **before dispatch**, never in `update` or replay. `openLwwClock`
persists a counter independently of the outbox, so a rejected or unsubmitted
write cannot cause timestamp reuse after reload:

```ts
import { Effect } from 'effect'
import { indexedDb, openLwwClock } from 'foldkit-sync'

const clock = await Effect.runPromise(
  Effect.gen(function* () {
    const storage = yield* indexedDb('todos-tab-a-clock')
    return yield* openLwwClock({ documentId: 'todos', replicaId: 'tab-a', storage })
  }),
)
try {
  const stamp = await Effect.runPromise(
    clock.next(Effect.runSync(replica.shared).title.stamp.counter),
  )
  await Effect.runPromise(
    replica.submit({ _tag: 'Renamed', title: { stamp, value: 'Milk' } }),
  )
} finally {
  await Effect.runPromise(clock.close)
}
```

Use a **separate database** from the replica's outbox, with one clock per
document/writer. `next(observedCounter)` returns only after persisting a counter
greater than both its saved value and the supplied observation. Pass the latest
observed counter for the field being edited; when causality spans several
registers, pass their maximum. Calling `next()` without an observation advances
only the saved local counter. The clock does not inspect application state.

Allocations on one handle are serialized. Separate handles use storage's
compare-and-swap check; a stale handle fails and must be closed and reopened.
Storage failures reject allocation without returning a stamp. Counter gaps after
a crash or failed submission are harmless. Counters are nonnegative safe
integers; exhaustion fails before writing. `close()` waits for accepted
allocations and refuses new ones. Opening takes ownership of storage and closes
it on initialization failure too.

Keep the clock database across reloads and outbox resets. If it is lost or
deleted, use a fresh replica id instead of resetting the same writer's counter.
For applications that allocate stamps themselves, preserve this same durable
high-water mark, including refused writes.

A stamp identifies one immutable write within a register. Repeated delivery of
the same value is harmless; different values with the same stamp throw. Value
equality comes from the supplied schema. `merge` takes decoded values, while
the Message and shared-state schemas perform validation at the normal sync
boundaries. Transforming value codecs retain both their encoded and decoded
types.

Keep the **whole register**, including the winning stamp, in shared snapshots.
For deletion, `lwwRegister(Schema.NullOr(Entity))` can retain a `null` tombstone:
dropping its stamp would allow an old offline write to resurrect the value.
A newer write may intentionally replace that tombstone.

The journal still orders and authorizes every operation, including losing writes.
Replica ids and counters in Messages are client-authored data, not authenticated
identity. Applications must enforce writer ownership and clock policy at admission
where needed. A losing write can still trigger a Command if the application's
update produces one; this helper only resolves state.

These M8 helpers do not change the todo example's persisted schema or claim
arbitrary Messages commute. Specialized sets, counters and collaborative text
remain future work.
