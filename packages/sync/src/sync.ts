import { Effect, Metric, Ref, Schema, SynchronizedRef } from 'effect'
import {
  CheckpointRegressionError,
  CommittedOrderError,
  ForeignRejectionError,
  InvalidOutboxError,
  InvalidReplicaHistoryError,
  ReplicaClosedError,
  WrongReplicaStorageError,
  type ReplicaError,
} from './errors.js'
import type { Storage } from './indexedDb.js'
import { Transport, TransportError } from './transport.js'

const Sequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

/** A client-authored operation envelope. `message` is the application's encoded Message. */
const OperationSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  schemaVersion: Schema.Literal(1),
  documentId: Schema.NonEmptyString,
  replicaId: Schema.NonEmptyString,
  localSequence: Sequence,
  opId: Schema.NonEmptyString,
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
export type Committed = typeof CommittedSchema.Type

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
  readonly cursor: number
  readonly model: Shared
}

export interface Exchange<Shared> {
  readonly operations: ReadonlyArray<unknown>
  readonly rejected: ReadonlyArray<string>
  /** Sends from the request that are durably committed, so the replica can drop them. */
  readonly acknowledged?: ReadonlyArray<string> | undefined
  /** The snapshot a replica predating compaction adopts in place of the log. */
  readonly checkpoint?: Checkpoint<Shared> | undefined
}

export interface ReplicaState<Shared> {
  readonly protocolVersion: 1
  readonly schemaVersion: 1
  readonly documentId: string
  readonly replicaId: string
  readonly revision: number
  readonly nextLocalSequence: number
  readonly cursor: number
  readonly committed: Shared
  readonly committedIds: ReadonlyArray<string>
  readonly pending: ReadonlyArray<Operation>
}

/**
 * What the promise-based edge adapter consumes; the Effect `Transport` service
 * is the primary seam.
 */
export interface TransportClient {
  exchange(cursor: number, pending: ReadonlyArray<Operation>): Promise<unknown>
}

export interface Replica<Message, Shared> {
  /** The optimistic projection: committed state with pending operations replayed. */
  readonly shared: Effect.Effect<Shared>
  readonly pending: Effect.Effect<ReadonlyArray<Operation>>
  readonly cursor: Effect.Effect<number>
  readonly submit: (message: Message) => Effect.Effect<void, ReplicaError>
  /** Reconciles against the server. The `Transport` service must be provided. */
  readonly synchronize: Effect.Effect<void, ReplicaError | TransportError, Transport>
  readonly close: Effect.Effect<void>
}

export interface SyncDefinition<Message, Shared, MessageEncoded, SharedEncoded> {
  readonly documentId: string
  readonly message: Schema.Codec<Message, MessageEncoded, never, never>
  readonly shared: Schema.Codec<Shared, SharedEncoded, never, never>
  readonly empty: Shared
  readonly durable: (message: Message) => boolean
  readonly replay: (shared: Shared, message: Message) => Shared
}

export interface Sync<Message, Shared> {
  readonly documentId: string
  readonly normalizeOperation: (input: unknown) => Operation
  readonly operationFrom: (input: unknown, documentId: string) => Operation
  readonly committedFrom: (input: unknown, documentId: string) => Committed
  readonly decodeExchange: (input: unknown) => Exchange<Shared>
  readonly openReplica: (
    replicaId: string,
    storage: Storage<ReplicaState<Shared>>,
  ) => Effect.Effect<Replica<Message, Shared>, ReplicaError>
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

  const ReplicaStateSchema = Schema.Struct({
    protocolVersion: Schema.Literal(1),
    schemaVersion: Schema.Literal(1),
    documentId: Schema.NonEmptyString,
    replicaId: Schema.NonEmptyString,
    revision: Sequence,
    nextLocalSequence: Sequence,
    cursor: Sequence,
    committed: definition.shared,
    committedIds: Schema.Array(Schema.String),
    pending: Schema.Array(OperationSchema),
  })
  const CheckpointSchema = Schema.Struct({ cursor: Sequence, model: definition.shared })
  const ExchangeSchema = Schema.Struct({
    operations: Schema.Array(Schema.Unknown),
    rejected: Schema.Array(Schema.NonEmptyString),
    acknowledged: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    checkpoint: Schema.optional(CheckpointSchema),
  })
  const decodeState = Schema.decodeUnknownSync(ReplicaStateSchema, { onExcessProperty: 'error' })
  const decodeExchange = (input: unknown): Exchange<Shared> =>
    Schema.decodeUnknownSync(ExchangeSchema, { onExcessProperty: 'error' })(
      input,
    ) as Exchange<Shared>

  const checkIdentity = (operation: Operation): void => {
    if (
      operation.localSequence < 1 ||
      operation.opId !== `${operation.replicaId}:${operation.localSequence}`
    ) {
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
  const assertDocument = <O extends Operation>(operation: O, key: string): O => {
    if (operation.documentId !== key) throw new Error('Wrong document')
    return operation
  }
  const normalizeOperation = (input: unknown): Operation => shape(decodeOperation(input))
  const operationFrom = (input: unknown, key: string): Operation =>
    assertDocument(normalizeOperation(input), key)
  /**
   * A committed operation arrives with its message already encoded, so decode it
   * once for the contract check and hand it to `replay` instead of decoding and
   * re-encoding it on the way through `shape`.
   */
  const decodeCommittedOperation = (
    input: unknown,
    key: string,
  ): { readonly committed: Committed; readonly message: Message } => {
    const committed = assertDocument(decodeCommitted(input), key)
    checkIdentity(committed)
    return { committed, message: decodeDurable(committed.message) }
  }
  const committedFrom = (input: unknown, key: string): Committed =>
    decodeCommittedOperation(input, key).committed

  const optimistic = (state: ReplicaState<Shared>): Shared =>
    state.pending.reduce(
      (model, operation) => definition.replay(model, decodeMessage(operation.message)),
      state.committed,
    )

  const openReplica = (
    replicaId: string,
    storage: Storage<ReplicaState<Shared>>,
  ): Effect.Effect<Replica<Message, Shared>, ReplicaError> =>
    Effect.gen(function* () {
      const saved = yield* storage.load()
      const initial: ReplicaState<Shared> = {
        protocolVersion: 1,
        schemaVersion: 1,
        documentId,
        replicaId,
        revision: 0,
        nextLocalSequence: 1,
        cursor: 0,
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
      if (saved === undefined) yield* storage.save(state, null)

      const stateRef = yield* SynchronizedRef.make(state)
      const closed = yield* Ref.make(false)

      // `SynchronizedRef.modifyEffect` installs the returned state itself, so
      // persisting must not also set the ref (that would re-enter the lock).
      const persist = (next: ReplicaState<Shared>, current: ReplicaState<Shared>) =>
        storage.save(next, current.revision)

      const submit = (message: Message): Effect.Effect<void, ReplicaError> =>
        // The closed check belongs inside the lock: a `close` between an outer
        // check and acquiring the lock would otherwise still persist.
        SynchronizedRef.modifyEffect(stateRef, current =>
          Effect.gen(function* () {
            if (yield* Ref.get(closed))
              return yield* new ReplicaClosedError({ message: 'Replica is closed' })
            const operation = yield* Effect.try({
              try: () =>
                operationFrom(
                  {
                    protocolVersion: 1,
                    schemaVersion: 1,
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
            const next = yield* Effect.try({
              try: () =>
                decodeState({
                  ...current,
                  revision: current.revision + 1,
                  nextLocalSequence: current.nextLocalSequence + 1,
                  pending: [...current.pending, operation],
                }),
              catch: cause =>
                new InvalidReplicaHistoryError({ message: 'Invalid replica state', cause }),
            })
            yield* persist(next, current)
            return [undefined, next] as const
          }),
        ).pipe(Effect.withSpan('Sync.submit', { attributes: { documentId, replicaId } }))

      const synchronize: Replica<Message, Shared>['synchronize'] = Effect.gen(function* () {
        const transport = yield* Transport
        if (yield* Ref.get(closed))
          return yield* new ReplicaClosedError({ message: 'Replica is closed' })
        const sent = yield* SynchronizedRef.get(stateRef)
        yield* Metric.update(syncMetrics.exchanges, 1)
        yield* Metric.update(syncMetrics.exchangePending, sent.pending.length)
        const response = decodeExchange(
          yield* transport.exchange(sent.cursor, sent.pending).pipe(
            Effect.tapError(error =>
              Effect.logWarning('sync exchange failed', {
                documentId,
                replicaId,
                error: error.message,
              }),
            ),
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
            for (const id of rejected)
              if (!sentIds.has(id))
                return yield* new ForeignRejectionError({
                  opId: id,
                  message: 'Server rejected an operation that was not sent',
                })
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
            const next = yield* Effect.try({
              try: () =>
                decodeState({
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
                }),
              catch: cause =>
                new InvalidReplicaHistoryError({ message: 'Invalid replica state', cause }),
            })
            yield* persist(next, current)
            return [undefined, next] as const
          }),
        )
      }).pipe(Effect.withSpan('Sync.synchronize', { attributes: { documentId } }))

      return {
        shared: Effect.map(SynchronizedRef.get(stateRef), optimistic),
        pending: Effect.map(SynchronizedRef.get(stateRef), state => state.pending),
        cursor: Effect.map(SynchronizedRef.get(stateRef), state => state.cursor),
        submit,
        synchronize,
        close: Effect.gen(function* () {
          yield* Ref.set(closed, true)
          yield* storage.close
        }),
      }
    }).pipe(Effect.withSpan('Sync.openReplica', { attributes: { documentId, replicaId } }))

  return {
    documentId,
    normalizeOperation,
    operationFrom,
    committedFrom,
    decodeExchange,
    openReplica,
  }
}
