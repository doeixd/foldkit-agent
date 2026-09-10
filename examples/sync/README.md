# Durable Foldkit messages: feasibility spike

This private example answers the six feasibility questions in [issue #42](https://github.com/doeixd/foldkit-agent/issues/42). It is a concrete todo application, not a published sync API. Foldkit's existing Message union and `update` function define every transition on the browser and server.

## Run

Use the workspace's pinned Node 22.21.1 runtime through pnpm:

```sh
pnpm install
pnpm demo
pnpm exec vitest run examples/sync/test
pnpm --filter foldkit-agent-example-sync dev
```

The command-line demo recovers an offline outbox, converges two replicas through a SQLite journal, and dispatches server agent capabilities through the same journal as another producer. Its browser storage is emulated with `fake-indexeddb`.

The dev page uses native IndexedDB and the real Foldkit runtime. Add a todo, select it, and reload: the todo survives while selection resets. This flow was also checked in Chromium. The page exercises local durability; the two-client reconciliation tests use emulated IndexedDB and real SQLite. There is no network server in this example.

## Findings

| Question | Evidence and limit |
| --- | --- |
| Can a wrapper intercept selected Messages without modifying Foldkit? | `runtime.ts` wraps `update`, subscriptions, and Commands before calling `Runtime.makeApplication` and `Runtime.embed`. Durable application Messages become persistence Commands. A completion Message installs the resulting shared projection. Local Messages continue through the same application update. |
| Can existing Schemas represent the data? | `app.ts` defines Model and Message once. `sync.ts` binds them to `foldkit-sync` (`defineSync`), which encodes Messages and strictly decodes operation envelopes, persisted snapshots, and exchange responses. Only `todos` is shared; selection and errors are omitted from storage. The example uses JSON-compatible fields; transformed/non-JSON schemas need explicit encoded snapshot handling before generalizing. |
| Does replay produce the same shared state? | The journal, optimistic projection, and reconciliation all call `replay`, which calls the application's `update`. Tests converge conflicting offline renames according to server order. IDs are Message inputs; update does not generate IDs or read clocks or local selection. |
| Can IndexedDB support the replica and outbox? | One transaction stores the committed snapshot/cursor, pending operations, sequence allocator, and revision. Publication waits for transaction completion with strict durability requested. Reload recovery, failed writes, and competing writers are tested. A revision comparison prevents two tabs sharing an identity from overwriting each other; the losing writer must reopen. |
| Can a small journal establish ordering? | `journal.ts` uses SQLite transactions to atomically append an operation and update a snapshot. Unique document/op IDs make retransmission idempotent, including after compaction; reuse with different input or actor fails while the payload is retained. A replica behind the compaction floor adopts the snapshot as a checkpoint instead of the pruned log. Cursor catch-up and offline reconciliation converge two clients. A file-backed restart test verifies persistence. |
| What core hook is needed? | None for this state-only wrapper. It delays the domain transition by returning a persistence Command and later a refresh Message. A transparent generic wrapper would benefit from a serialized, asynchronous admission hook before the application update, plus a way to install a shared projection without redispatching it as a new local operation. |

## Ordering and failure behavior

The local replica records an envelope with `replicaId:localSequence`, document ID, protocol/schema versions, and base cursor. It persists the new outbox before publishing an optimistic projection. A failed save leaves the visible state and sequence unchanged. Local writes are serialized; network exchange runs outside that queue so edits can continue during a pull.

The server accepts an already authenticated `Principal` supplied by the transport. Actor identity never comes from an operation, and a committed record always stores the principal's actor. The example has document-scoped read access and a write permission flag; an actual HTTP/WebSocket adapter must authenticate requests and derive that context itself. An `authorize` policy passed to `openJournal` is consulted against the authoritative Model before an operation commits; a refusal removes the outbox entry without applying or committing anything, while validation and identity conflicts still fail the exchange. `append`, `read`, and `snapshot` are trusted in-process APIs, not public endpoints.

The client replays newly committed operations in server order, removes acknowledged or explicitly refused pending entries, then replays remaining pending operations on that committed projection. A lost acknowledgement causes safe resend. The server reports acknowledged send IDs explicitly, so a pending operation it committed and then compacted is dropped rather than replayed onto the snapshot the replica adopts. Unknown rejection IDs, malformed responses, unsupported versions, and gaps fail without changing saved state. Concurrent renames use server order. Delete is an ordinary ordered operation; later rename of a missing entity is a no-op.

Compaction drops committed payloads but keeps one identity row per operation so retransmission stays idempotent, and a replica behind the floor adopts the snapshot as a checkpoint. There is no compaction schedule and the identity rows are never garbage-collected. The journal's storage schema is created fresh: a column added by a later change (as compaction did) is not migrated, so an existing journal file has to be recreated. There is no CRDT merge, peer-to-peer authority, presence channel, Message-schema migration, production transport, or general package API. Retained identity rows and committed IDs still make storage and replay costs grow with history and outbox size. Browser storage eviction and abrupt machine power loss are outside the recovery tests.

An `AgentRuntime` bound to the journal (`serverAgentHost`) is an ordinary producer: a capability dispatch becomes one operation authored by a dedicated replica, under the caller's authenticated principal. The contract's `authorize` is the typed refusal a caller sees; the journal policy underneath is the authoritative backstop, so a binding that diverges from it fails loudly instead of committing. That backstop refusal is a host throw, which the agent runtime turns into a defect rather than a typed dispatch failure, so an adapter reports it as an unexpected error; a capability that wants a clean refusal declares `authorize`.

The MCP handler is exercised over that runtime in a transport-free test: an initialize plus a `tools/call` commits one durable operation, and a browser replica converges on it. The host supplies `subscribe` (backed by the journal announcing each commit), so the handler can follow the authoritative Model. No HTTP, A2A, or Agent Native transport is wired in this example, and the MCP adapter is a test-only dependency.

## Replay and the runtime boundary

Durable transitions must be state-only. Replay rejects Commands and changes to local fields. These checks catch the illustrated mistakes; they cannot prove that arbitrary JavaScript is deterministic or prevent side effects executed directly inside an impure update. External work belongs in Commands with explicit authority and idempotency before it can join this design.

The wrapper's persistence Command produces internal `RefreshShared` or `PersistenceFailed` Messages. Foldkit devtools therefore see those internal transitions. Port send acceptance is not a durability acknowledgement; the shared Model changes only after persistence completes. Replica callers can await `submit` directly. `synchronize` refreshes the mounted application after reconciliation while preserving local selection.

A future core admission hook should serialize acceptance, await persistence, reject without applying on failure, and distinguish replay from fresh local dispatch. It must define cancellation and disposal semantics. Until that hook exists, this wrapper is suitable for the demonstrated state-only domain but does not promise transparent durability for an arbitrary Foldkit application.
