import { Effect, Exit, Metric, PubSub, Queue, Ref, Schema, Stream, SynchronizedRef } from 'effect'
import {
  CheckpointRegressionError,
  CommittedOrderError,
  ForeignAcknowledgementError,
  ForeignRejectionError,
  InvalidExchangeError,
  InvalidOutboxError,
  InvalidReplicaHistoryError,
  ReplayError,
  ReplicaClosedError,
  UnsupportedReplicaVersionError,
  WrongReplicaStorageError,
  type ReplicaError,
} from './errors.js'
import type { Storage } from './indexedDb.js'
import {
  DocumentId,
  LocalSequence,
  OpId,
  ReplicaId,
  Sequence,
  localSequence,
  sequence,
} from './ids.js'
import { Transport, TransportError } from './transport.js'

/** Wire and persisted-format versions. A bump must handle the older value explicitly. */
const PROTOCOL_VERSION = 1
const SCHEMA_VERSION = 1

/** A client-authored operation envelope. `message` is the application's encoded Message. */
const OperationSchema = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  documentId: DocumentId,
  replicaId: ReplicaId,
  localSequence: LocalSequence,
  opId: OpId,
  baseCursor: Sequence,
  message: Schema.Unknown,
})
export type Operation = typeof OperationSchema.Type

/** An operation the server committed, with its authoritative order and actor. */
const CommittedSchema = Schema.Struct({
  ...OperationSchema.fields,
  serverSequence: Sequence.check(Schema.isGreaterThanOrEqualTo(1)),
  actorId: Schema.NonEmptyString,
})
/** Named to avoid colliding with `foldkit-durable`'s `Committed`. */
export type CommittedOperation = typeof CommittedSchema.Type

const decodeOperation = Schema.decodeUnknownSync(OperationSchema, { onExcessProperty: 'error' })
const decodeCommitted = Schema.decodeUnknownSync(CommittedSchema, { onExcessProperty: 'error' })

/**
 * How many committed-operation ids a replica retains for duplicate detection.
 * Committed sequences are contiguous and the server enforces `opId`
 * uniqueness, so this is defence in depth; bounding it keeps replica state from
 * growing without limit on a log that is never checkpointed.
 */
const COMMITTED_ID_WINDOW = 1024

/** Counters and a histogram an application can scrape. */
export const syncMetrics = {
  exchanges: Metric.counter('foldkit_sync_exchanges_total'),
  applied: Metric.counter('foldkit_sync_commits_applied_total'),
  checkpoints: Metric.counter('foldkit_sync_checkpoints_adopted_total'),
  exchangePending: Metric.histogram('foldkit_sync_exchange_pending', {
    boundaries: [1, 4, 16, 64, 256, 1024],
  }),
}

export interface Checkpoint<Shared> {
  readonly cursor: Sequence
  readonly model: Shared
}

export interface Exchange<Shared> {
  /** Server-committed operations as they arrived; validated against `CommittedOperation` on adoption. */
  readonly operations: ReadonlyArray<unknown>
  readonly rejected: ReadonlyArray<OpId>
  /** Sends from the request that are durably committed, so the replica can drop them. */
  readonly acknowledged?: ReadonlyArray<OpId> | undefined
  /** The snapshot a replica predating compaction adopts in place of the log. */
  readonly checkpoint?: Checkpoint<Shared> | undefined
}

export interface ReplicaState<Shared> {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly documentId: DocumentId
  readonly replicaId: ReplicaId
  readonly revision: number
  readonly nextLocalSequence: LocalSequence
  readonly cursor: Sequence
  readonly committed: Shared
  readonly committedIds: ReadonlyArray<string>
  readonly pending: ReadonlyArray<Operation>
}

/**
 * What the promise-based edge adapter consumes; the Effect `Transport` service
 * is the primary seam.
 */
export interface TransportClient {
  exchange(cursor: Sequence, pending: ReadonlyArray<Operation>): Promise<unknown>
}

/** A redacted view of a replica's state, for a UI to explain and recover. */
export interface ReplicaStatus {
  readonly pending: number
  readonly cursor: Sequence
  /** The last exchange failure, cleared by a successful exchange. */
  readonly lastError: string | undefined
  /** Operations the server refused, most recent first. */
  readonly rejected: ReadonlyArray<OpId>
}

/**
 * A consistent status and optimistic-shared pair, read from one replica state.
 * `Replica.changes` emits it so a UI can hold a single subscription.
 */
export interface ReplicaSnapshot<Shared> {
  readonly status: ReplicaStatus
  readonly shared: Shared
}

export interface Replica<Message, Shared> {
  /** The optimistic projection: committed state with pending operations replayed. */
  readonly shared: Effect.Effect<Shared>
  readonly pending: Effect.Effect<ReadonlyArray<Operation>>
  readonly cursor: Effect.Effect<Sequence>
  /**
   * Waiting/recovery information without exposing Messages or the Model. It is a
   * snapshot; `statusChanges` re-emits it after every submit and exchange.
   */
  readonly status: Effect.Effect<ReplicaStatus>
  /** The status, re-emitted after every submit and exchange. */
  readonly statusChanges: Stream.Stream<ReplicaStatus>
  /**
   * The status and the optimistic shared value together, re-emitted after every
   * submit and exchange, so a UI can subscribe once instead of to both.
   */
  readonly changes: Stream.Stream<ReplicaSnapshot<Shared>>
  readonly submit: (message: Message) => Effect.Effect<void, ReplicaError>
  /** Reconciles against the server. The `Transport` service must be provided. */
  readonly synchronize: Effect.Effect<void, ReplicaError | TransportError, Transport>
  /**
   * The exchange loop: exchanges once, then after every `submit`, until the
   * replica closes or the fiber is interrupted. A transport failure is recorded
   * in `status.lastError` and retried on the next wake, so the fiber never
   * fails. Fork it with `Effect.forkScoped` and provide `Transport`.
   */
  readonly start: Effect.Effect<void, never, Transport>
  readonly close: Effect.Effect<void>
}

export interface SyncDefinition<Message, Shared, MessageEncoded, SharedEncoded> {
  readonly documentId: DocumentId
  readonly message: Schema.Codec<Message, MessageEncoded, never, never>
  readonly shared: Schema.Codec<Shared, SharedEncoded, never, never>
  readonly empty: Shared
  readonly durable: (message: Message) => boolean
  readonly replay: (shared: Shared, message: Message) => Shared
}

export interface Sync<Message, Shared> {
  readonly documentId: DocumentId
  /**
   * Low-level wire codecs for adapters and the transport. Most applications use
   * `journalContract` and `openReplica`; these are exposed for a custom
   * transport or a server that must speak the operation envelope directly.
   */
  readonly codec: {
    readonly normalizeOperation: (input: unknown) => Operation
    readonly operationFrom: (input: unknown, documentId: DocumentId) => Operation
    readonly committedFrom: (input: unknown, documentId: DocumentId) => CommittedOperation
    readonly decodeExchange: (input: unknown) => Exchange<Shared>
  }
  /** The codecs and pure reducer `foldkit-durable`'s `makeJournal` consumes. */
  readonly journalContract: () => JournalContract<Operation, Shared>
  readonly openReplica: (
    replicaId: ReplicaId,
    storage: Storage,
  ) => Effect.Effect<Replica<Message, Shared>, ReplicaError>
}

/** Structural match for `foldkit-durable`'s journal options; Sync stays independent. */
export interface JournalContract<Operation, Shared> {
  readonly operation: {
    /** Operations are stored in their encoded form, so this is the identity. */
    readonly encode: (operation: Operation) => Operation
    readonly decode: (input: unknown) => Operation
  }
  readonly snapshot: {
    readonly encode: (snapshot: Shared) => unknown
    readonly decode: (input: unknown) => Shared
  }
  readonly empty: () => Shared
  readonly reduce: (snapshot: Shared, operation: Operation) => Shared
}

/**
 * Binds the replicated-state protocol to one application contract.
 *
 * The returned codecs decide what is a valid operation and what the shared
 * projection means; the replica owns the local outbox, optimistic projection,
 * and reconciliation as Effects, and never runs a second reducer.
 */
export const defineSync = <Message, Shared, MessageEncoded, SharedEncoded>(
  definition: SyncDefinition<Message, Shared, MessageEncoded, SharedEncoded>,
): Sync<Message, Shared> => {
  const documentId = definition.documentId
  const decodeMessage = Schema.decodeUnknownSync(definition.message, { onExcessProperty: 'error' })
  const encodeMessage = Schema.encodeSync(definition.message)
  const decodeShared = Schema.decodeUnknownSync(definition.shared, { onExcessProperty: 'error' })
  const encodeShared = Schema.encodeSync(definition.shared)

  const ReplicaStateSchema = Schema.Struct({
    protocolVersion: Schema.Literal(PROTOCOL_VERSION),
    schemaVersion: Schema.Literal(SCHEMA_VERSION),
    documentId: DocumentId,
    replicaId: ReplicaId,
    revision: Schema.Number,
    nextLocalSequence: LocalSequence,
    cursor: Sequence,
    committed: definition.shared,
    committedIds: Schema.Array(Schema.String),
    pending: Schema.Array(OperationSchema),
  })
  const CheckpointSchema = Schema.Struct({ cursor: Sequence, model: definition.shared })
  const ExchangeSchema = Schema.Struct({
    operations: Schema.Array(Schema.Unknown),
    rejected: Schema.Array(OpId),
    acknowledged: Schema.optional(Schema.Array(OpId)),
    checkpoint: Schema.optional(CheckpointSchema),
  })
  const decodeState = Schema.decodeUnknownSync(ReplicaStateSchema, { onExcessProperty: 'error' })
  const encodeState = Schema.encodeSync(ReplicaStateSchema)
  const VersionProbe = Schema.Struct({
    protocolVersion: Schema.optional(Schema.Number),
    schemaVersion: Schema.optional(Schema.Number),
  })
  /**
   * Tells a version this build does not understand apart from malformed data,
   * so the caller gets an actionable failure and the stored state is preserved.
   */
  const unsupportedVersion = (input: unknown): UnsupportedReplicaVersionError | undefined => {
    let found: {
      readonly protocolVersion?: number | undefined
      readonly schemaVersion?: number | undefined
    }
    try {
      found = Schema.decodeUnknownSync(VersionProbe)(input)
    } catch {
      return undefined
    }
    if (found.protocolVersion === PROTOCOL_VERSION && found.schemaVersion === SCHEMA_VERSION)
      return undefined
    const protocolVersion = found.protocolVersion ?? null
    const schemaVersion = found.schemaVersion ?? null
    return new UnsupportedReplicaVersionError({
      protocolVersion,
      schemaVersion,
      message: `Stored replica uses protocol ${protocolVersion ?? '?'} / schema ${schemaVersion ?? '?'}; this build supports ${PROTOCOL_VERSION}/${SCHEMA_VERSION}`,
    })
  }
  const decodeExchange = (input: unknown): Exchange<Shared> =>
    Schema.decodeUnknownSync(ExchangeSchema, { onExcessProperty: 'error' })(
      input,
    ) as Exchange<Shared>

  const checkIdentity = (operation: Operation): void => {
    // `LocalSequence` already rejects a non-positive counter; this checks the
    // derived identity.
    if (operation.opId !== `${operation.replicaId}:${operation.localSequence}`) {
      throw new Error('Invalid operation identity')
    }
  }
  const decodeDurable = (message: unknown): Message => {
    const decoded = decodeMessage(message)
    if (!definition.durable(decoded)) throw new Error('Message is local-only')
    return decoded
  }
  const shape = <O extends Operation>(operation: O): O => {
    checkIdentity(operation)
    return { ...operation, message: encodeMessage(decodeDurable(operation.message)) }
  }
  const assertDocument = <O extends Operation>(operation: O, key: DocumentId): O => {
    if (operation.documentId !== key) throw new Error('Wrong document')
    return operation
  }
  const normalizeOperation = (input: unknown): Operation => shape(decodeOperation(input))
  const operationFrom = (input: unknown, key: DocumentId): Operation =>
    assertDocument(normalizeOperation(input), key)
  /**
   * A committed operation arrives with its message already encoded, so decode it
   * once for the contract check and hand it to `replay` instead of decoding and
   * re-encoding it on the way through `shape`.
   */
  const decodeCommittedOperation = (
    input: unknown,
    key: DocumentId,
  ): { readonly committed: CommittedOperation; readonly message: Message } => {
    const committed = assertDocument(decodeCommitted(input), key)
    checkIdentity(committed)
    return { committed, message: decodeDurable(committed.message) }
  }
  const committedFrom = (input: unknown, key: DocumentId): CommittedOperation =>
    decodeCommittedOperation(input, key).committed

  const journalContract = (): JournalContract<Operation, Shared> => ({
    // Operations are stored in their encoded form: `normalizeOperation` has
    // already encoded the Message and validated the identity.
    operation: { encode: operation => operation, decode: normalizeOperation },
    snapshot: { encode: encodeShared, decode: decodeShared },
    empty: () => definition.empty,
    reduce: (snapshot, operation) => definition.replay(snapshot, decodeMessage(operation.message)),
  })

  const optimistic = (state: ReplicaState<Shared>): Shared =>
    state.pending.reduce(
      (model, operation) => definition.replay(model, decodeMessage(operation.message)),
      state.committed,
    )

  const openReplica = Effect.fn('Sync.openReplica')(
    function* (replicaId: ReplicaId, storage: Storage) {
      yield* Effect.annotateCurrentSpan({ documentId, replicaId })
      const saved = yield* storage.load()
      const initial: ReplicaState<Shared> = {
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        documentId,
        replicaId,
        revision: 0,
        nextLocalSequence: localSequence(1),
        cursor: sequence(0),
        committed: definition.empty,
        committedIds: [],
        pending: [],
      }
      const state: ReplicaState<Shared> =
        saved === undefined
          ? initial
          : yield* Effect.try({
              try: () => decodeState(saved),
              catch: cause =>
                unsupportedVersion(saved) ??
                new InvalidReplicaHistoryError({
                  message: 'Stored replica state is invalid',
                  cause,
                }),
            })
      if (state.documentId !== documentId || state.replicaId !== replicaId)
        return yield* new WrongReplicaStorageError({
          documentId,
          replicaId,
          message: 'The stored replica belongs to a different document or replica',
        })
      const committedIds = new Set(state.committedIds)
      if (state.nextLocalSequence < 1 || committedIds.size !== state.committedIds.length)
        return yield* new InvalidReplicaHistoryError({ message: 'Invalid replica history' })
      const pendingIds = new Set<string>()
      for (const pending of state.pending) {
        const operation = yield* Effect.try({
          try: () => operationFrom(pending, documentId),
          catch: () => new InvalidOutboxError({ message: 'Invalid outbox' }),
        })
        if (
          operation.replicaId !== replicaId ||
          operation.localSequence >= state.nextLocalSequence ||
          committedIds.has(operation.opId) ||
          pendingIds.has(operation.opId)
        )
          return yield* new InvalidOutboxError({ message: 'Invalid outbox' })
        pendingIds.add(operation.opId)
      }
      // Storage holds the schema's encoded side, so a transforming `shared`
      // codec round-trips: decode on load, encode before every save. Encoding
      // also rejects an invalid `empty` on first creation rather than at reload.
      const store = Effect.fn('Sync.store')(function* (
        next: ReplicaState<Shared>,
        expectedRevision: number | null,
      ) {
        const encoded = yield* Effect.try({
          try: () => encodeState(next),
          catch: cause =>
            new InvalidReplicaHistoryError({
              message: 'Could not encode the replica state',
              cause,
            }),
        })
        yield* storage.save(encoded, expectedRevision)
      })
      if (saved === undefined) yield* store(state, null)

      const stateRef = yield* SynchronizedRef.make(state)
      const closed = yield* Ref.make(false)
      const lastError = yield* Ref.make<string | undefined>(undefined)
      const rejectedOps = yield* Ref.make<ReadonlyArray<OpId>>([])
      // One pending wake-up is enough: the loop exchanges the whole outbox.
      const wake = yield* Queue.sliding<void>(1)
      const statusSignals = yield* PubSub.sliding<void>(1)
      // The projection is pure over an immutable state, so a cached value is
      // reused until a write replaces the state object. A UI reads `shared` far
      // more often than it writes, and replaying a large outbox per read is
      // quadratic (see `bench/projection.bench.ts`).
      const projection = yield* Ref.make<
        { readonly state: ReplicaState<Shared>; readonly shared: Shared } | undefined
      >(undefined)
      const snapshot = Effect.fn('Sync.snapshot')(function* () {
        const current = yield* SynchronizedRef.get(stateRef)
        const cached = yield* Ref.get(projection)
        let projected: Shared
        if (cached !== undefined && cached.state === current) projected = cached.shared
        else {
          projected = optimistic(current)
          yield* Ref.set(projection, { state: current, shared: projected })
        }
        return {
          status: {
            pending: current.pending.length,
            cursor: current.cursor,
            lastError: yield* Ref.get(lastError),
            rejected: yield* Ref.get(rejectedOps),
          },
          shared: projected,
        }
      })()
      const shared = Effect.map(snapshot, value => value.shared)
      const status = Effect.map(snapshot, value => value.status)

      // `SynchronizedRef.modifyEffect` installs the returned state itself, so
      // persisting must not also set the ref (that would re-enter the lock).
      const persist = (next: ReplicaState<Shared>, current: ReplicaState<Shared>) =>
        store(next, current.revision)

      const submit = Effect.fn('Sync.submit')(function* (message: Message) {
        yield* Effect.annotateCurrentSpan({ documentId, replicaId })
        const result = yield* SynchronizedRef.modifyEffect(stateRef, current =>
          Effect.gen(function* () {
            if (yield* Ref.get(closed))
              return yield* new ReplicaClosedError({ message: 'Replica is closed' })
            const operation = yield* Effect.try({
              try: () =>
                operationFrom(
                  {
                    protocolVersion: PROTOCOL_VERSION,
                    schemaVersion: SCHEMA_VERSION,
                    documentId,
                    replicaId,
                    localSequence: current.nextLocalSequence,
                    opId: `${replicaId}:${current.nextLocalSequence}`,
                    baseCursor: current.cursor,
                    message: encodeMessage(message),
                  },
                  documentId,
                ),
              catch: () => new InvalidOutboxError({ message: 'Invalid outbox' }),
            })
            // Replay before writing: a Message replay refuses can never be
            // applied, here or on another replica, so it must not reach the
            // outbox. The result is the next optimistic projection, so the
            // cache is seeded instead of replaying the outbox on the next read.
            // Rebuilding the projection replays the outbox, which can throw
            // too (an upgrade that changed `update` for a pending Message), so
            // it sits inside the same typed error as the new Message's replay.
            const cached = yield* Ref.get(projection)
            const replayed = yield* Effect.try({
              try: () =>
                definition.replay(
                  cached !== undefined && cached.state === current
                    ? cached.shared
                    : optimistic(current),
                  message,
                ),
              catch: cause =>
                new ReplayError({
                  message: cause instanceof Error ? cause.message : 'Replay failed',
                  cause,
                }),
            })
            // Validated and encoded by `persist`; decoding here would demand the
            // encoded side and break a transforming `shared` codec.
            const next: ReplicaState<Shared> = {
              ...current,
              revision: current.revision + 1,
              nextLocalSequence: localSequence(current.nextLocalSequence + 1),
              pending: [...current.pending, operation],
            }
            yield* persist(next, current)
            yield* Ref.set(projection, { state: next, shared: replayed })
            yield* Queue.offer(wake, undefined)
            return [undefined, next] as const
          }),
        )
        // Outside the lock, so a `statusChanges` subscriber reads the new state.
        yield* PubSub.publish(statusSignals, undefined)
        return result
      })

      const synchronize = Effect.fn('Sync.synchronize')(function* () {
        yield* Effect.annotateCurrentSpan({ documentId })
        const transport = yield* Transport
        if (yield* Ref.get(closed))
          return yield* new ReplicaClosedError({ message: 'Replica is closed' })
        const sent = yield* SynchronizedRef.get(stateRef)
        yield* Metric.update(syncMetrics.exchanges, 1)
        yield* Metric.update(syncMetrics.exchangePending, sent.pending.length)
        const response = yield* Effect.gen(function* () {
          const raw = yield* transport.exchange(sent.cursor, sent.pending)
          // The response is untrusted: a malformed shape is a typed failure, not
          // a defect that escapes the declared error channel.
          return yield* Effect.try({
            try: () => decodeExchange(raw),
            catch: cause =>
              new InvalidExchangeError({ message: 'Invalid sync exchange response', cause }),
          })
        }).pipe(
          Effect.tapError(error =>
            Effect.gen(function* () {
              yield* Effect.logWarning('sync exchange failed', {
                documentId,
                replicaId,
                error: error.message,
              })
              yield* Ref.set(lastError, error.message)
            }),
          ),
        )
        yield* SynchronizedRef.modifyEffect(stateRef, current =>
          Effect.gen(function* () {
            // A `close` during the exchange must not persist its result.
            if (yield* Ref.get(closed))
              return yield* new ReplicaClosedError({ message: 'Replica is closed' })
            let cursor = current.cursor
            let committed = current.committed
            // A checkpoint folds committed history into its snapshot, so the
            // retained id set starts over from it.
            const ids =
              response.checkpoint === undefined ? new Set(current.committedIds) : new Set<string>()
            if (response.checkpoint !== undefined) {
              if (response.checkpoint.cursor < cursor)
                return yield* new CheckpointRegressionError({
                  cursor,
                  checkpointCursor: response.checkpoint.cursor,
                  message: 'Checkpoint is behind the replica',
                })
              committed = response.checkpoint.model
              cursor = response.checkpoint.cursor
              yield* Metric.update(syncMetrics.checkpoints, 1)
              yield* Effect.logDebug('sync checkpoint adopted', { documentId, replicaId, cursor })
            }
            const acknowledged = new Set(response.acknowledged ?? [])
            const rejected = new Set(response.rejected)
            const sentIds = new Set(sent.pending.map(operation => operation.opId))
            for (const id of acknowledged)
              if (!sentIds.has(id))
                return yield* new ForeignAcknowledgementError({
                  opId: id,
                  message: 'Server acknowledged an operation that was not sent',
                })
            for (const id of rejected) {
              if (!sentIds.has(id))
                return yield* new ForeignRejectionError({
                  opId: id,
                  message: 'Server rejected an operation that was not sent',
                })
              // An id cannot be both; removal would be ambiguous and a faulty
              // server must not be able to make a pending operation vanish.
              if (acknowledged.has(id))
                return yield* new ForeignAcknowledgementError({
                  opId: id,
                  message: 'Server both acknowledged and rejected an operation',
                })
            }
            let applied = 0
            for (const raw of response.operations) {
              const { committed: operation, message } = yield* Effect.try({
                try: () => decodeCommittedOperation(raw, documentId),
                catch: cause =>
                  new InvalidReplicaHistoryError({ message: 'Invalid committed operation', cause }),
              })
              if (operation.serverSequence <= cursor) continue
              if (operation.serverSequence !== cursor + 1 || ids.has(operation.opId))
                return yield* new CommittedOrderError({
                  expected: cursor + 1,
                  actual: operation.serverSequence,
                  message: 'Invalid committed order',
                })
              committed = definition.replay(committed, message)
              ids.add(operation.opId)
              cursor = operation.serverSequence
              applied += 1
            }
            if (applied > 0) yield* Metric.update(syncMetrics.applied, applied)
            // Validated and encoded by `persist`, for the same reason as submit.
            const next: ReplicaState<Shared> = {
              ...current,
              revision: current.revision + 1,
              committed,
              cursor,
              committedIds: [...ids].slice(-COMMITTED_ID_WINDOW),
              pending: current.pending.filter(
                operation =>
                  !ids.has(operation.opId) &&
                  !acknowledged.has(operation.opId) &&
                  !rejected.has(operation.opId),
              ),
            }
            yield* persist(next, current)
            return [undefined, next] as const
          }),
        )
        yield* Ref.set(lastError, undefined)
        if (response.rejected.length > 0)
          yield* Ref.update(rejectedOps, previous =>
            [...response.rejected, ...previous].slice(0, 32),
          )
        yield* PubSub.publish(statusSignals, undefined)
      })()

      const start: Effect.Effect<void, never, Transport> = Effect.gen(function* () {
        yield* synchronize.pipe(Effect.catch(() => Effect.void))
        while (!(yield* Ref.get(closed))) {
          yield* Queue.take(wake)
          if (yield* Ref.get(closed)) return
          yield* synchronize.pipe(Effect.catch(() => Effect.void))
        }
      })

      return {
        shared,
        pending: Effect.map(SynchronizedRef.get(stateRef), state => state.pending),
        cursor: Effect.map(SynchronizedRef.get(stateRef), state => state.cursor),
        status,
        statusChanges: Stream.concat(
          Stream.fromEffect(status),
          Stream.fromPubSub(statusSignals).pipe(Stream.mapEffect(() => status)),
        ),
        changes: Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromPubSub(statusSignals).pipe(Stream.mapEffect(() => snapshot)),
        ),
        submit,
        synchronize,
        start,
        close: Effect.fn('Sync.close')(function* () {
          yield* Ref.set(closed, true)
          // Wake `start` so it can observe `closed` and return.
          yield* Queue.offer(wake, undefined)
          yield* storage.close
        })(),
      }
    },
    (effect, _replicaId, storage) =>
      // Close a partially initialized storage on any failure, including a
      // defect, so a failed open cannot leak the connection.
      effect.pipe(
        Effect.onExit(exit =>
          Exit.isSuccess(exit) ? Effect.void : storage.close.pipe(Effect.ignore),
        ),
      ),
  )

  return {
    documentId,
    codec: { normalizeOperation, operationFrom, committedFrom, decodeExchange },
    journalContract,
    openReplica,
  }
}
