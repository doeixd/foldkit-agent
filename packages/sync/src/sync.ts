import { Schema } from 'effect'
import type { Storage } from './indexedDb.js'

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

export interface Transport {
  exchange(cursor: number, pending: ReadonlyArray<Operation>): Promise<unknown>
}

export interface Replica<Message, Shared> {
  shared(): Shared
  pending(): ReadonlyArray<Operation>
  cursor(): number
  submit(message: Message): Promise<void>
  synchronize(transport: Transport): Promise<void>
  close(): Promise<void>
}

/**
 * What `foldkit-sync` needs to know about an application.
 *
 * The Message union and the shared projection are the application's own schemas,
 * so an operation is always decoded with the application's contract. `replay`
 * is the application's transition function, restricted to the shared projection.
 */
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
  ) => Promise<Replica<Message, Shared>>
}

/**
 * Binds the replicated-state protocol to one application contract.
 *
 * The returned codecs decide what is a valid operation and what the shared
 * projection means; the replica owns the local outbox, optimistic projection,
 * and reconciliation, and never runs a second reducer.
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

  const shape = <O extends Operation>(operation: O): O => {
    if (
      operation.localSequence < 1 ||
      operation.opId !== `${operation.replicaId}:${operation.localSequence}`
    ) {
      throw new Error('Invalid operation identity')
    }
    const message = decodeMessage(operation.message)
    if (!definition.durable(message)) throw new Error('Message is local-only')
    return { ...operation, message: encodeMessage(message) }
  }
  const assertDocument = <O extends Operation>(operation: O, key: string): O => {
    if (operation.documentId !== key) throw new Error('Wrong document')
    return operation
  }
  const normalizeOperation = (input: unknown): Operation => shape(decodeOperation(input))
  const operationFrom = (input: unknown, key: string): Operation =>
    assertDocument(normalizeOperation(input), key)
  const committedFrom = (input: unknown, key: string): Committed =>
    assertDocument(shape(decodeCommitted(input)), key)

  const openReplica = async (
    replicaId: string,
    storage: Storage<ReplicaState<Shared>>,
  ): Promise<Replica<Message, Shared>> => {
    const saved = await storage.load()
    let state: ReplicaState<Shared> = decodeState(
      saved === undefined
        ? {
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
        : saved,
    )
    if (state.documentId !== documentId || state.replicaId !== replicaId)
      throw new Error('Wrong replica storage')
    const committedIds = new Set(state.committedIds)
    if (state.nextLocalSequence < 1 || committedIds.size !== state.committedIds.length) {
      throw new Error('Invalid replica history')
    }
    const pendingIds = new Set<string>()
    for (const pending of state.pending) {
      const operation = operationFrom(pending, documentId)
      if (
        operation.replicaId !== replicaId ||
        operation.localSequence >= state.nextLocalSequence ||
        committedIds.has(operation.opId) ||
        pendingIds.has(operation.opId)
      )
        throw new Error('Invalid outbox')
      pendingIds.add(operation.opId)
    }
    const optimistic = (next: ReplicaState<Shared>): Shared =>
      next.pending.reduce(
        (model, operation) => definition.replay(model, decodeMessage(operation.message)),
        next.committed,
      )
    let shared = optimistic(state)
    if (saved === undefined) await storage.save(state, null)

    let tail = Promise.resolve()
    let closed = false
    const enqueue = <A>(action: () => Promise<A>): Promise<A> => {
      if (closed) return Promise.reject(new Error('Replica is closed'))
      const running = tail.then(action)
      tail = running.then(
        () => {},
        () => {},
      )
      return running
    }
    const commit = async (next: ReplicaState<Shared>): Promise<void> => {
      const projected = optimistic(next)
      await storage.save(next, state.revision)
      state = next
      shared = projected
    }
    return {
      shared: () => structuredClone(shared),
      pending: () => structuredClone(state.pending),
      cursor: () => state.cursor,
      submit: message =>
        enqueue(async () => {
          const operation = operationFrom(
            {
              protocolVersion: 1,
              schemaVersion: 1,
              documentId,
              replicaId,
              localSequence: state.nextLocalSequence,
              opId: `${replicaId}:${state.nextLocalSequence}`,
              baseCursor: state.cursor,
              message: encodeMessage(message),
            },
            documentId,
          )
          await commit(
            decodeState({
              ...state,
              revision: state.revision + 1,
              nextLocalSequence: state.nextLocalSequence + 1,
              pending: [...state.pending, operation],
            }),
          )
        }),
      synchronize: async transport => {
        // Keep networking outside the local write queue so offline edits can continue.
        const sent = await enqueue(async () => ({
          cursor: state.cursor,
          pending: structuredClone(state.pending),
        }))
        const response = decodeExchange(await transport.exchange(sent.cursor, sent.pending))
        await enqueue(async () => {
          let cursor = state.cursor
          let committed = state.committed
          // A checkpoint folds committed history into its snapshot, so the
          // retained id set starts over from it. Ops at or before its cursor are
          // already in the model; later ones are still applied below.
          const ids =
            response.checkpoint === undefined ? new Set(state.committedIds) : new Set<string>()
          if (response.checkpoint !== undefined) {
            if (response.checkpoint.cursor < cursor)
              throw new Error('Checkpoint is behind the replica')
            committed = response.checkpoint.model
            cursor = response.checkpoint.cursor
          }
          // A checkpoint covers no log rows, so an operation the server committed
          // before compacting it would otherwise stay pending and replay twice.
          const acknowledged = new Set(response.acknowledged ?? [])
          const rejected = new Set(response.rejected)
          const sentIds = new Set(sent.pending.map(operation => operation.opId))
          if ([...rejected].some(id => !sentIds.has(id))) {
            throw new Error('Server rejected an operation that was not sent')
          }
          for (const raw of response.operations) {
            const operation = committedFrom(raw, documentId)
            if (operation.serverSequence <= cursor) continue
            if (operation.serverSequence !== cursor + 1 || ids.has(operation.opId))
              throw new Error('Invalid committed order')
            committed = definition.replay(committed, decodeMessage(operation.message))
            ids.add(operation.opId)
            cursor = operation.serverSequence
          }
          await commit(
            decodeState({
              ...state,
              revision: state.revision + 1,
              committed,
              cursor,
              committedIds: [...ids],
              pending: state.pending.filter(
                operation =>
                  !ids.has(operation.opId) &&
                  !acknowledged.has(operation.opId) &&
                  !rejected.has(operation.opId),
              ),
            }),
          )
        })
      },
      close: async () => {
        if (closed) return
        closed = true
        await tail
        storage.close()
      },
    }
  }

  return {
    documentId,
    normalizeOperation,
    operationFrom,
    committedFrom,
    decodeExchange,
    openReplica,
  }
}
