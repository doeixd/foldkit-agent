/**
 * The sync server's journal: `foldkit-durable` on a real SQLite file, exposed
 * through the synchronous and promise seams the transport and the replica
 * speak. `node:sqlite` is synchronous, so reads and writes run to completion.
 */
import { Effect, Exit, Fiber, Scope, Stream } from 'effect'
import {
  actorId as toActorId,
  cursor as toCursor,
  documentId as toDocumentId,
  makeJournal,
  opId as toOpId,
  sequence as toSequence,
  type AppendResult as DurableAppendResult,
  type Committed as DurableCommitted,
  type Journal as DurableJournal,
} from 'foldkit-durable'
import {
  documentId as toSyncDocumentId,
  type CommittedOperation as Committed,
  type Operation,
  type TransportClient,
} from 'foldkit-sync'
import { encodeShared, type Message, type Shared } from './app.js'
import { Sync } from './sync.js'

/** Supplied by a trusted transport, never decoded from an operation. */
export interface SyncPrincipal {
  readonly actorId: string
  readonly documentId: string
  readonly canWrite: boolean
}

export interface Journal {
  readonly append: (input: unknown, principal: SyncPrincipal) => Committed
  /** Appends a Message a server-side producer authored, using its own id. */
  readonly appendAsServer: (
    message: Message,
    principal: SyncPrincipal,
    producer: string,
  ) => Committed
  readonly read: (documentId: string, after: number) => ReadonlyArray<Committed>
  readonly compact: (documentId: string, through: number) => void
  readonly snapshot: (documentId: string) => { readonly cursor: number; readonly model: Shared }
  readonly subscribe: (listener: (key: string) => void) => () => void
  readonly transport: (principal: SyncPrincipal) => TransportClient
  readonly close: () => void
}

export const openJournal = (path: string): Journal => {
  const scope = Effect.runSync(Scope.make())
  const durable: DurableJournal<Operation, Shared, SyncPrincipal> = (() => {
    try {
      return Effect.runSync(
        makeJournal<Operation, Shared, SyncPrincipal>({
          // The replica contract also produces the durable journal's codecs,
          // initial snapshot, and replay, so they are not written twice.
          ...Sync.journalContract(),
          file: path,
          opId: operation => toOpId(operation.opId),
          actorId: principal => toActorId(principal.actorId),
          validate: ({ key, operation, cursor }) => {
            if (String(operation.documentId) !== String(key)) throw new Error('Wrong document')
            if (operation.baseCursor > cursor)
              throw new Error('Operation cursor is ahead of the server')
          },
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
    } catch (error) {
      Effect.runSync(Scope.close(scope, Exit.void))
      throw error
    }
  })()

  const toCommitted = (committed: DurableCommitted<Operation>, documentId: string): Committed =>
    Sync.codec.committedFrom(
      { ...committed.operation, serverSequence: committed.sequence, actorId: committed.actorId },
      toSyncDocumentId(documentId),
    )

  const snapshot = (documentId: string): { cursor: number; model: Shared } => {
    const { cursor, snapshot: model } = Effect.runSync(durable.load(toDocumentId(documentId)))
    return { cursor, model }
  }

  const append = (input: unknown, principal: SyncPrincipal): Committed => {
    if (!principal.actorId || !principal.canWrite) throw new Error('Unauthorized operation')
    const result: DurableAppendResult<Operation> = Effect.runSync(
      durable.append(toDocumentId(principal.documentId), input, principal),
    )
    if (result._tag === 'AlreadyCommitted')
      throw new Error(
        `Operation "${result.opId}" was already committed and its payload was compacted`,
      )
    return toCommitted(result.committed, principal.documentId)
  }

  /**
   * A server producer has no local outbox, so it sequences from the
   * authoritative cursor. The cursor only advances, which keeps the operation
   * identity unique and survives a restart; `producer` labels the author.
   */
  const appendAsServer = (
    message: Message,
    principal: SyncPrincipal,
    producer: string,
  ): Committed => {
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
    Effect.runSync(durable.read(toDocumentId(documentId), toCursor(after))).map(committed =>
      toCommitted(committed, documentId),
    )

  return {
    append,
    appendAsServer,
    read,
    compact: (documentId, through) =>
      Effect.runSync(durable.compact(toDocumentId(documentId), toSequence(through))),
    snapshot,
    subscribe: listener => {
      const fiber = Effect.runFork(
        Stream.runForEach(durable.subscribe, key =>
          Effect.sync(() => listener(key)).pipe(Effect.catchCause(() => Effect.void)),
        ),
      )
      return () => Effect.runSync(Fiber.interrupt(fiber))
    },
    transport: (principal: SyncPrincipal): TransportClient => ({
      exchange: async (cursor, pending) => {
        if (!principal.actorId) throw new Error('Unauthenticated reader')
        const rejected: string[] = []
        const acknowledged: string[] = []
        for (const input of pending) {
          const operation = Sync.codec.normalizeOperation(input)
          if (!principal.canWrite) {
            rejected.push(operation.opId)
            continue
          }
          const result = Effect.runSync(
            durable.append(toDocumentId(principal.documentId), operation, principal).pipe(
              Effect.catchTag('OperationRejectedError', error =>
                Effect.sync(() => {
                  rejected.push(error.opId)
                  return undefined
                }),
              ),
            ),
          )
          if (result === undefined) continue
          // A commit made before compaction has no payload left to replay.
          acknowledged.push(
            result._tag === 'AlreadyCommitted' ? result.opId : result.committed.operation.opId,
          )
        }
        // A read below the floor means the client must adopt a checkpoint. The
        // read decides that itself, so a compaction cannot slip between the
        // floor check and the read and produce a gapped stream.
        const caught = Effect.runSync(
          durable.read(toDocumentId(principal.documentId), toCursor(cursor)).pipe(
            Effect.map(rows => ({ rows })),
            Effect.catchTag('CompactedCursorError', () =>
              Effect.succeed({ checkpoint: true as const }),
            ),
          ),
        )
        if ('checkpoint' in caught) {
          const { cursor: at, model } = snapshot(principal.documentId)
          return {
            checkpoint: { cursor: at, model: encodeShared(model) },
            operations: [],
            rejected,
            acknowledged,
          }
        }
        return {
          operations: caught.rows.map(committed => toCommitted(committed, principal.documentId)),
          rejected,
          acknowledged,
        }
      },
    }),
    close: () => {
      Effect.runSync(Scope.close(scope, Exit.void))
    },
  }
}
