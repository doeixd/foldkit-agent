/**
 * `foldkit-sync` — a local-first replica of a shared Foldkit projection.
 *
 * The application's Message union and update function stay authoritative: sync
 * wraps them rather than introducing a second reducer. The replica owns the
 * local outbox, optimistic projection, and reconciliation; a durable server
 * journal provides authoritative order.
 */
export { indexedDb, type Storage } from './indexedDb.js'
export { mount, type MountOptions, type Mounted } from './mount.js'
export {
  forApplication,
  type ApplicationSync,
  type MakeOptions,
  type DefinedSync,
  type MsgOf,
} from './make.js'
export {
  DocumentId,
  LocalSequence,
  OpId,
  ReplicaId,
  Sequence,
  documentId,
  localSequence,
  opId,
  replicaId,
  sequence,
} from './ids.js'
export {
  CheckpointRegressionError,
  CommittedOrderError,
  ForeignAcknowledgementError,
  ForeignRejectionError,
  InvalidExchangeError,
  InvalidOutboxError,
  InvalidReplicaHistoryError,
  ReplayError,
  ReplicaClosedError,
  StorageError,
  UnsupportedClockVersionError,
  UnsupportedReplicaVersionError,
  WrongReplicaStorageError,
  type ReplicaError,
} from './errors.js'
export { lwwRegister, openLwwClock, type LwwClock, type LwwClockState } from './lww.js'
export {
  createPresence,
  createPresenceHub,
  loopbackPresenceChannel,
  servePresence,
  socketPresenceChannel,
  type Presence,
  type PresenceChannel,
  type PresenceHub,
  type PresenceOptions,
  type PresencePeer,
  type PresenceUpdate,
} from './presence.js'
export {
  layerFromPromise,
  layerLoopback,
  layerSocket,
  nativeSocket,
  serveSocket,
  toPromise,
  Transport,
  TransportError,
  type ExchangeFrame,
  type ExchangeReply,
  type SocketLike,
  type SocketOptions,
  type TransportShape,
} from './transport.js'
export {
  defineSync,
  syncMetrics,
  type Checkpoint,
  type CommittedOperation,
  type Exchange,
  type JournalContract,
  type Operation,
  type Replica,
  type ReplicaSnapshot,
  type ReplicaState,
  type ReplicaStatus,
  type Sync,
  type SyncDefinition,
  type TransportClient,
} from './sync.js'
