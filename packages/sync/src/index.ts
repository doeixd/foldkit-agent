/**
 * `foldkit-sync` — a local-first replica of a shared Foldkit projection.
 *
 * The application's Message union and update function stay authoritative: sync
 * wraps them rather than introducing a second reducer. The replica owns the
 * local outbox, optimistic projection, and reconciliation; a durable server
 * journal provides authoritative order.
 */
export { indexedDb, type Storage } from './indexedDb.js'
export {
  defineSync,
  type Checkpoint,
  type Committed,
  type Exchange,
  type Operation,
  type Replica,
  type ReplicaState,
  type Sync,
  type SyncDefinition,
  type Transport,
} from './sync.js'
