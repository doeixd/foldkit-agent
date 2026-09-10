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

## Limits

- IndexedDB is the only storage adapter.
- It assumes an authoritative, single-writer-per-document server that orders
  operations; there is no peer-to-peer or CRDT merge.
- Presence has no channel yet.
- Unpublished: `private` until an application other than the sync spike depends
  on the API.
