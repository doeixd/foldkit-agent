# `foldkit-durable`

A durable, ordered operation log with a snapshot and cursor per key. It is the
storage half of replicated Foldkit state; application semantics stay in the
`reduce` the caller supplies.

```ts
import { createJournal } from 'foldkit-durable'

const journal = createJournal({
  file: 'journal.sqlite',
  operation: { encode: operation => operation, decode: readOperation },
  snapshot: { encode: snapshot => snapshot, decode: readSnapshot },
  empty: () => ({ todos: [] }),
  reduce: (snapshot, operation) => applyTodo(snapshot, operation),
  opId: operation => operation.opId,
  actorId: principal => principal.actorId,
})

journal.append('todos', operation, principal)
journal.read('todos', 0)
```

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

- SQLite via the experimental `node:sqlite` built-in is the only adapter, so the
  package is Node-only.
- The storage schema is created fresh; a schema change is not migrated onto an
  existing file.
- Unpublished: `private` until an application other than the sync spike depends
  on the API.
