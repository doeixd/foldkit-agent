import {
  createJournal,
  OperationRejectedError,
  type Committed as DurableCommitted,
} from 'foldkit-durable'
import type { Committed, Operation, TransportClient } from 'foldkit-sync'
import { decodeShared, decodeMessage, replay, type Message, type Shared } from './app.js'
import { Sync } from './sync.js'

/** Supplied by a trusted transport, never decoded from an operation. */
export interface Principal {
  readonly actorId: string
  readonly documentId: string
  readonly canWrite: boolean
}

/** What the application's authorization policy sees before an operation commits. */
export interface AuthorizationRequest {
  readonly principal: Principal
  readonly message: Message
  readonly model: Shared
}

/** Decides whether a principal may commit an operation against the current Model. */
export type Authorize = (request: AuthorizationRequest) => boolean

/** An externally visible effect a committed operation triggers server-side. */
export interface ServerEffect {
  readonly name: string
  readonly run: () => Promise<void>
}

export interface JournalPolicy {
  /** Defaults to allowing; an authenticated write still requires `Principal.canWrite`. */
  readonly authorize?: Authorize
  /**
   * Effects a committed operation triggers. Each runs at most once per
   * operation, keyed by the operation id, so a resend or replay cannot
   * duplicate it.
   */
  readonly effects?: (message: Message) => ReadonlyArray<ServerEffect>
}

/**
 * The sync server's journal: the durable package configured for this
 * application's operation envelope and shared Model.
 */
export const openJournal = (path: string, policy: JournalPolicy = {}) => {
  const authorize = policy.authorize
  const effectsFor = policy.effects
  const durable = createJournal<Operation, Shared, Principal>({
    file: path,
    operation: { encode: operation => operation, decode: Sync.normalizeOperation },
    snapshot: { encode: snapshot => snapshot, decode: decodeShared },
    empty: () => ({ todos: [] }),
    reduce: (snapshot, operation) => replay(snapshot, decodeMessage(operation.message)),
    opId: operation => operation.opId,
    actorId: principal => principal.actorId,
    validate: ({ key, operation, cursor }) => {
      if (operation.documentId !== key) throw new Error('Wrong document')
      if (operation.baseCursor > cursor) throw new Error('Operation cursor is ahead of the server')
    },
    ...(authorize === undefined
      ? {}
      : {
          authorize: ({ principal, operation, snapshot }) =>
            authorize({ principal, message: decodeMessage(operation.message), model: snapshot }),
        }),
  })

  /** The durable record, flattened into the wire shape the protocol exchanges. */
  const toCommitted = (committed: DurableCommitted<Operation>, documentId: string): Committed =>
    Sync.committedFrom(
      { ...committed.operation, serverSequence: committed.sequence, actorId: committed.actorId },
      documentId,
    )

  const append = (input: unknown, principal: Principal): Committed => {
    if (!principal.actorId || !principal.canWrite) throw new Error('Unauthorized operation')
    return toCommitted(durable.append(principal.documentId, input, principal), principal.documentId)
  }

  /**
   * Appends a Message a server-side producer authored, sequencing it from the
   * authoritative cursor.
   *
   * A server producer has no local outbox and no persisted sequence, so it
   * cannot supply a genuine per-replica counter. The cursor only advances, which
   * keeps the operation identity unique and survives a restart; `producer`
   * labels who authored it in the log.
   */
  const appendAsServer = (message: Message, principal: Principal, producer: string): Committed => {
    const baseCursor = durable.load(principal.documentId).cursor
    return append(
      {
        protocolVersion: 1,
        schemaVersion: 1,
        documentId: principal.documentId,
        replicaId: producer,
        localSequence: baseCursor + 1,
        opId: `${producer}:${baseCursor + 1}`,
        baseCursor,
        message,
      },
      principal,
    )
  }

  const read = (documentId: string, after: number): ReadonlyArray<Committed> =>
    durable.read(documentId, after).map(committed => toCommitted(committed, documentId))

  const snapshot = (documentId: string): { cursor: number; model: Shared } => {
    const { cursor, snapshot: model } = durable.load(documentId)
    return { cursor, model }
  }

  /**
   * Runs the effects a committed operation declared, once each.
   *
   * Safe to call for an operation already settled: the ledger keys each effect
   * to the operation, so a resend, replay, or second call is a no-op.
   */
  const settle = async (committed: Committed): Promise<void> => {
    const effects = effectsFor?.(decodeMessage(committed.message)) ?? []
    for (const [index, effect] of effects.entries()) {
      // `opId` is only replica-scoped, so the document has to be part of the
      // effect key: two documents may share a `replicaId:sequence`.
      await durable.runEffect(
        `${committed.documentId}/${committed.opId}/command/${index}`,
        effect.run,
      )
    }
  }

  return {
    append,
    appendAsServer,
    settle,
    subscribe: durable.subscribe,
    read,
    compact: durable.compact,
    snapshot,
    transport: (principal: Principal): TransportClient => ({
      exchange: async (cursor, pending) => {
        if (!principal.actorId) throw new Error('Unauthenticated reader')
        const rejected: string[] = []
        const acknowledged: string[] = []
        for (const input of pending) {
          // Validation and identity conflicts fail the exchange; an authorization
          // refusal is a policy answer, so it removes the outbox entry instead.
          const operation = Sync.normalizeOperation(input)
          if (!principal.canWrite) {
            rejected.push(operation.opId)
            continue
          }
          try {
            const committed = append(operation, principal)
            // Settled before the ack, so the client's retry cannot repeat it.
            await settle(committed)
            acknowledged.push(committed.opId)
          } catch (error) {
            if (error instanceof OperationRejectedError) rejected.push(error.opId)
            else throw error
          }
        }
        // The replica's range predates the compacted payloads, so the log cannot
        // fill it in; hand back the snapshot. Pending was still appended above
        // and is acknowledged, so nothing the replica authored is replayed onto
        // the snapshot it is about to adopt.
        if (cursor < durable.floor(principal.documentId)) {
          const { cursor: at, model } = snapshot(principal.documentId)
          return { checkpoint: { cursor: at, model }, operations: [], rejected, acknowledged }
        }
        return { operations: read(principal.documentId, cursor), rejected, acknowledged }
      },
    }),
    close: durable.close,
  }
}

export type Journal = ReturnType<typeof openJournal>
