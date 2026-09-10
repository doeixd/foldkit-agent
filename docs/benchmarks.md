# Benchmarks

`pnpm bench` runs the Vitest benchmarks in `packages/sync/bench` and prints
hz/mean/p99 per scenario. A weekly [Bench workflow](../.github/workflows/bench.yml)
runs the same command and prints to the job log; it is not a gate, because shared
runners are too noisy to fail a build on a timing regression.

## Recorded run

- Windows 11, Node 20.20.0, pnpm 10.32.1.
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

## Initial supported limits

With one replica per document, from the recorded run:

- **Outbox.** Up to ~1,000 pending operations keeps startup in single-digit
  milliseconds and every `shared` read near 1 µs. Past that, startup grows
  linearly; an application expecting a multi-thousand-operation offline backlog
  should checkpoint its own work rather than rely on the outbox alone.
- **Reconcile batch.** A 1,000-commit batch reconciles in ~10 ms. Larger batches
  should be paginated by the transport.
- These are `foldkit-sync`'s local costs. `foldkit-durable`'s append and
  compaction costs are not measured here.
