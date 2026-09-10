# Benchmarks

`pnpm bench` runs the Vitest benchmarks in `packages/sync/bench` and prints
hz/mean/p99 per scenario; `pnpm bench:storage` appends a fixed number of
operations to a file-backed durable journal and prints a bytes-per-operation
reading. A weekly [Bench workflow](../.github/workflows/bench.yml) runs both and
prints to the job log; it is not a gate, because shared runners are too noisy to
fail a build on a timing regression.

## Recorded run

- Windows 11, Node 22.21.1 (the workspace runtime, via pnpm), pnpm 10.32.1.
- Committed model of 100 todos; an outbox of `p` local `CreatedTodo`s.
- Treat the numbers as order-of-magnitude. Re-run locally for your machine.

## What was measured, and the one change it drove

The optimistic projection (`replica.shared`) replays the pending outbox over the
committed state. It used to run on every read, and an append-heavy replay is
quadratic in the outbox, so every read paid for the whole backlog.

| outbox | `shared` read, before | `shared` read, after |
| ---: | ---: | ---: |
| 0 | 0.7 µs | 1.0 µs |
| 100 | 246 µs | 1.0 µs |
| 1000 | 6.3 ms | 1.0 µs |
| 5000 | 102 ms | 1.0 µs |

`shared` now caches the projection against the immutable state object and reuses
it until a write replaces that object, so repeated reads are O(1) and the
projection runs once per write instead of once per read. `sync.test.ts` pins this
by counting `replay` calls; a cache that ignores the state identity returns a
stale projection and the test fails.

`openReplica` still decodes and validates the whole outbox at startup, which the
outbox identity checks need:

| outbox | startup |
| ---: | ---: |
| 0 | 0.12 ms |
| 100 | 0.64 ms |
| 1000 | 5.6 ms |
| 5000 | 28 ms |

Reconnect/rebase (open a replica with a 100-op outbox, then adopt a committed
batch) costs about 1.5 ms for 100 commits and 10 ms for 1000.

## Durable append and storage

`pnpm bench:storage` appends a fixed number of operations to a file-backed
journal, prints bytes per operation, then compacts every payload and prints the
size again. Recorded on the same Windows/Node 22 machine:

| | |
| --- | --- |
| operations | 5,000 |
| append | 5.0 ms/op (synchronous; dominated by Windows fsync) |
| storage | 104 B/op |
| after compacting all payloads | unchanged (520,192 bytes) |
| heap / rss | 36 MB / 158 MB |

Compaction drops payloads but does not shrink the file: identity rows remain and
SQLite keeps freed pages, so storage tracks the number of operations, not the
payload bytes compacted away. That matches the [retention policy](../packages/durable/README.md#retention) —
bounding storage means rotating the journal. Append is a synchronous
transaction, so the per-op time is the platform's fsync; CI's `ubuntu` runner is
faster than this laptop.

A long offline outbox is also exercised deterministically in CI: `sync.test.ts`'s
`recovers a long offline outbox and converges on the committed order` submits 500
operations offline and reconciles them in one exchange.

## Initial supported limits

With one replica per document, from the recorded run:

- **Outbox.** Up to ~1,000 pending operations keeps startup in single-digit
  milliseconds and every `shared` read near 1 µs. Past that, startup grows
  linearly; an application expecting a multi-thousand-operation offline backlog
  should checkpoint its own work rather than rely on the outbox alone.
- **Reconcile batch.** A 1,000-commit batch reconciles in ~10 ms. Larger batches
  should be paginated by the transport.
- **Durable storage.** ~104 B per operation on the recorded run, and the file
  does not shrink on compaction, so storage grows with the number of operations.
  Rotate the journal per its [retention policy](../packages/durable/README.md#retention).
- These are `foldkit-sync`'s local costs and one `foldkit-durable` append/storage
  reading.
