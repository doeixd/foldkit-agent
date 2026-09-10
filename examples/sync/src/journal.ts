import { Effect, Exit, Fiber, Scope, Stream } from 'effect'
import {
  makeJournal,
  type Committed as DurableCommitted,
  type Journal as DurableJournal,
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
   * operation, keyed by the document and operation id, so a resend or replay
   * cannot duplicate it.
   */
  readonly effects?: (message: Message) => ReadonlyArray<ServerEffect>
}

export interface Journal {
  readonly append: (input: unknown, principal: Principal) => Committed
  readonly appendAsServer: (message: Message, principal: Principal, producer: string) => Committed
  readonly settle: (committed: Committed) => Promise<void>
  readonly read: (documentId: string, after: number) => ReadonlyArray<Committed>
  readonly compact: (documentId: string, through: number) => void
  readonly snapshot: (documentId: string) => { cursor: number; model: Shared }
  readonly subscribe: (listener: (key: string) => void) => () => void
  readonly transport: (principal: Principal) => TransportClient
  readonly close: () => void
}

/**
 * The sync server's journal: the Effect-native durable package configured for
 * this application, exposed through the synchronous and promise seams the
 * Foldkit runtime, agent host, and replica still speak.
 *
 * `node:sqlite` is synchronous, so the reads and writes run to completion here;
 * only settling an effect can suspend.
 */
export const openJournal = (path: string, policy: JournalPolicy = {}): Journal => {
  const authorize = policy.authorize
  const effectsFor = policy.effects
  const scope = Effect.runSync(Scope.make())
  const durable: DurableJournal<Operation, Shared, Principal> = (() => {
    try {
      return Effect.runSync(
        makeJournal<Operation, Shared, Principal>({
          file: path,
          operation: { encode: operation => operation, decode: Sync.normalizeOperation },
          snapshot: { encode: snapshot => snapshot, decode: decodeShared },
          empty: () => ({ todos: [] }),
          reduce: (snapshot, operation) => replay(snapshot, decodeMessage(operation.message)),
          opId: operation => operation.opId,
          actorId: principal => principal.actorId,
          validate: ({ key, operation, cursor }) => {
            if (operation.documentId !== key) throw new Error('Wrong document')
            if (operation.baseCursor > cursor)
              throw new Error('Operation cursor is ahead of the server')
          },
          ...(authorize === undefined
            ? {}
            : {
                authorize: ({ principal, operation, snapshot }) =>
                  authorize({
                    principal,
                    message: decodeMessage(operation.message),
                    model: snapshot,
                  }),
              }),
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
    } catch (error) {
      Effect.runSync(Scope.close(scope, Exit.void))
      throw error
    }
  })()

  /** The durable record, flattened into the wire shape the protocol exchanges. */
  const toCommitted = (committed: DurableCommitted<Operation>, documentId: string): Committed =>
    Sync.committedFrom(
      { ...committed.operation, serverSequence: committed.sequence, actorId: committed.actorId },
      documentId,
    )

  const append = (input: unknown, principal: Principal): Committed => {
    if (!principal.actorId || !principal.canWrite) throw new Error('Unauthorized operation')
    const committed = Effect.runSync(durable.append(principal.documentId, input, principal))
    return toCommitted(committed, principal.documentId)
  }

  const snapshot = (documentId: string): { cursor: number; model: Shared } => {
    const { cursor, snapshot: model } = Effect.runSync(durable.load(documentId))
    return { cursor, model }
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
    const baseCursor = snapshot(principal.documentId).cursor
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
    Effect.runSync(durable.read(documentId, after)).map(committed =>
      toCommitted(committed, documentId),
    )

  /**
   * Runs the effects a committed operation declared, once each.
   *
   * The ledger keys each effect to the document and operation, so a resend,
   * replay, or second call is a no-op.
   */
  const settle = async (committed: Committed): Promise<void> => {
    const effects = effectsFor?.(decodeMessage(committed.message)) ?? []
    for (const [index, effect] of effects.entries()) {
      await Effect.runPromise(
        durable.runEffect(
          `${committed.documentId}/${committed.opId}/command/${index}`,
          Effect.tryPromise({ try: () => effect.run(), catch: error => error }),
        ),
      )
    }
  }

  return {
    append,
    appendAsServer,
    settle,
    read,
    compact: (documentId, through) => Effect.runSync(durable.compact(documentId, through)),
    snapshot,
    // The agent host still registers a callback; the journal's subscription is
    // a Stream, so this is the edge where it is bridged back.
    subscribe: listener => {
      const fiber = Effect.runFork(
        Stream.runForEach(durable.subscribe, key =>
          Effect.sync(() => listener(key)).pipe(Effect.catchCause(() => Effect.void)),
        ),
      )
      return () => Effect.runSync(Fiber.interrupt(fiber))
    },
    transport: (principal: Principal): TransportClient => ({
      exchange: async (cursor, pending) => {
        if (!principal.actorId) throw new Error('Unauthenticated reader')
        const rejected: string[] = []
        const acknowledged: string[] = []
        for (const input of pending) {
          const operation = Sync.normalizeOperation(input)
          if (!principal.canWrite) {
            rejected.push(operation.opId)
            continue
          }
          const outcome = Effect.runSync(
            Effect.result(durable.append(principal.documentId, operation, principal)),
          )
          if (outcome._tag === 'Failure') {
            if (outcome.failure._tag === 'OperationRejectedError')
              rejected.push(outcome.failure.opId)
            else throw outcome.failure
          } else {
            // Settled before the ack, so the client's retry cannot repeat it.
            await settle(toCommitted(outcome.success, principal.documentId))
            acknowledged.push(outcome.success.operation.opId)
          }
        }
        if (cursor < Effect.runSync(durable.floor(principal.documentId))) {
          const { cursor: at, model } = snapshot(principal.documentId)
          return { checkpoint: { cursor: at, model }, operations: [], rejected, acknowledged }
        }
        return { operations: read(principal.documentId, cursor), rejected, acknowledged }
      },
    }),
    close: () => {
      Effect.runSync(Scope.close(scope, Exit.void))
    },
  }
}
