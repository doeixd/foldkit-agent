# `foldkit-sync`

A local-first replica of a shared Foldkit projection. The application's Message
union and `update` stay authoritative; sync wraps them rather than introducing a
second reducer.

```ts
import { defineSync, indexedDb } from 'foldkit-sync'

const Sync = defineSync({
  documentId: 'todos',
  message: Message,
  shared: Shared,
  empty: { todos: [] },
  durable: message => durableTags.has(message._tag),
  replay: (shared, message) => replay(shared, message),
})

const replica = await Sync.openReplica('tab-1', await indexedDb('todos-tab-1'))
await replica.submit(Message.CreatedTodo({ id: crypto.randomUUID(), title: 'Milk' }))
await replica.synchronize(transport)
```

## What it owns

- The operation envelope: `replicaId:localSequence` identity, `baseCursor`, and
  protocol/schema versions.
- A persisted outbox and optimistic projection: a durable Message is visible
  immediately and rebased onto the authoritative order.
- Reconciliation: committed operations are replayed in order, acknowledged or
  refused pending entries are dropped, and a checkpoint replaces the compacted
  prefix.
- Strict decoding: an operation is always validated with the application's
  Message schema, and a Message the contract does not call durable is refused.
- Presence (`createPresence`): an ephemeral, TTL'd peer registry, deliberately
  outside the durable log. A peer that stops refreshing is dropped, not
  replayed. It can travel over a socket — `socketPresenceChannel` on the client
  and `servePresence` fanning through a `createPresenceHub` on the server — or
  in-process via `loopbackPresenceChannel`.
- The transport seam (`Transport`): an Effect service with a loopback layer, a
  bridge to and from the promise client the replica speaks, and a WebSocket
  client layer that queues until the socket opens. `serveSocket` is the server
  side of a connection. A refusal is an exchange result; only a wire failure is
  a `TransportError`.

## Limits

- IndexedDB is the only storage adapter.
- It assumes an authoritative, single-writer-per-document server that orders
  operations; there is no peer-to-peer replication. Applications can opt individual
  fields into the specialized merge helper below.
- Binding the socket transport and presence server to a platform WebSocket
  server is left to the application; the sync example shows a `ws` one for the
  transport (presence over `ws` is not wired there yet).
- Unpublished: `private` until an application other than the sync spike depends
  on the API.

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

Allocate stamps **before dispatch**, never in `update` or replay. Counters are
nonnegative safe integers. For a new write, advance beyond both observed and
locally issued counters. Persist that local high-water mark even if a write is
refused, and never reuse a replica id with reset counters. Allocation is still
application-owned; the helper does not supply a durable logical clock.

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

This first M8 slice does not change the todo example's persisted schema or claim
arbitrary Messages commute. Sets, counters, collaborative text, and automatic
stamp allocation remain future work.
