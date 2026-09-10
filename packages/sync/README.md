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
  operations; there is no peer-to-peer or CRDT merge.
- Binding the socket transport and presence server to a platform WebSocket
  server is left to the application; the sync example shows a `ws` one for the
  transport (presence over `ws` is not wired there yet).
- Unpublished: `private` until an application other than the sync spike depends
  on the API.
