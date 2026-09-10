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
  type Checkpoint,
  type Committed,
  type Exchange,
  type Operation,
  type Replica,
  type ReplicaState,
  type Sync,
  type SyncDefinition,
  type TransportClient,
} from './sync.js'
