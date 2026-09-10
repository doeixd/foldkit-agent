import { decodeMessage, encodeMessage, replay, type Message, type Shared } from './app.js'
import {
  committedFrom,
  decodeExchange,
  decodeState,
  operationFrom,
  type Operation,
  type ReplicaState,
  type Transport,
} from './protocol.js'
import type { Storage } from './indexedDb.js'

export interface Replica {
  shared(): Shared
  pending(): ReadonlyArray<Operation>
  cursor(): number
  submit(message: Message): Promise<void>
  synchronize(transport: Transport): Promise<void>
  close(): Promise<void>
}

export const openReplica = async (
  documentId: string,
  replicaId: string,
  storage: Storage,
): Promise<Replica> => {
  const saved = await storage.load()
  let state: ReplicaState = decodeState(
    saved === undefined
      ? {
          protocolVersion: 1,
          schemaVersion: 1,
          documentId,
          replicaId,
          revision: 0,
          nextLocalSequence: 1,
          cursor: 0,
          committed: { todos: [] },
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
  const optimistic = (next: ReplicaState): Shared =>
    next.pending.reduce(
      (model, operation) => replay(model, decodeMessage(operation.message)),
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
  const commit = async (next: ReplicaState): Promise<void> => {
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
          committed = replay(committed, decodeMessage(operation.message))
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
