/**
 * `foldkit-durable` — a durable, ordered operation log with snapshots.
 *
 * Storage and ordering only; application semantics live in the `reduce` the
 * caller supplies. Append is atomic and idempotent by operation identity,
 * committed order is stable, and compaction never changes the logical state a
 * replay would produce.
 */
export type { Codec } from './codec.js'
export {
  createJournal,
  OperationRejectedError,
  type AuthorizationRequest,
  type Committed,
  type EffectRecord,
  type EffectStatus,
  type Journal,
  type JournalOptions,
  type ValidationRequest,
} from './journal.js'
