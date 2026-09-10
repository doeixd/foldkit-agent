import { createRequire } from 'node:module'
import { decodeShared, decodeMessage, replay, type Message, type Shared } from './app.js'
import { committedFrom, operationFrom, type Committed, type Transport } from './protocol.js'

// Vite 5's module resolver predates the node:sqlite built-in.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

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

export interface JournalPolicy {
  /** Defaults to allowing; an authenticated write still requires `Principal.canWrite`. */
  readonly authorize?: Authorize
}

/** The application's policy refused an operation; nothing was committed. */
export class OperationRejectedError extends Error {
  override readonly name = 'OperationRejectedError'
  constructor(readonly opId: string) {
    super(`Operation "${opId}" was refused by authorization`)
  }
}

export const openJournal = (path: string, policy: JournalPolicy = {}) => {
  const { authorize } = policy
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
      compact_before INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS operations (
      document_id TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      actor_id TEXT NOT NULL, input TEXT, committed TEXT,
      PRIMARY KEY (document_id, op_id), UNIQUE (document_id, sequence)
    );
  `)
  const readSnapshot = (documentId: string): { cursor: number; model: Shared } => {
    const row = database
      .prepare('SELECT cursor, snapshot FROM documents WHERE id = ?')
      .get(documentId)
    return row === undefined
      ? { cursor: 0, model: { todos: [] } }
      : {
          cursor: Number(row.cursor),
          model: decodeShared(JSON.parse(String(row.snapshot))),
        }
  }
  const compactBefore = (documentId: string): number => {
    const row = database
      .prepare('SELECT compact_before FROM documents WHERE id = ?')
      .get(documentId)
    return row === undefined ? 0 : Number(row.compact_before)
  }
  const append = (input: unknown, principal: Principal): Committed => {
    const operation = operationFrom(input, principal.documentId)
    if (!principal.actorId || !principal.canWrite) throw new Error('Unauthorized operation')
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database
        .prepare(
          'SELECT actor_id, sequence, input, committed FROM operations WHERE document_id = ? AND op_id = ?',
        )
        .get(operation.documentId, operation.opId)
      if (prior !== undefined) {
        // A compacted operation keeps its identity row but loses its payload.
        // A retransmission is still answered from that identity -- the snapshot
        // already folded it in, so nothing is replayed a second time.
        const committed =
          prior.committed === null
            ? committedFrom(
                {
                  ...operation,
                  serverSequence: Number(prior.sequence),
                  actorId: String(prior.actor_id),
                },
                principal.documentId,
              )
            : committedFrom(JSON.parse(String(prior.committed)), principal.documentId)
        // Only a retained payload can prove an identity conflict. After
        // compaction the operation is acknowledged without being re-applied.
        if (
          prior.input !== null &&
          (prior.input !== JSON.stringify(operation) || committed.actorId !== principal.actorId)
        )
          throw new Error('Operation identity conflict')
        database.exec('COMMIT')
        return committed
      }
      const snapshot = readSnapshot(operation.documentId)
      if (operation.baseCursor > snapshot.cursor)
        throw new Error('Operation cursor is ahead of the server')
      // Authorized against the authoritative Model, before anything is applied.
      const message = decodeMessage(operation.message)
      if (authorize !== undefined && !authorize({ principal, message, model: snapshot.model }))
        throw new OperationRejectedError(operation.opId)
      const model = replay(snapshot.model, message)
      const committed = committedFrom(
        { ...operation, serverSequence: snapshot.cursor + 1, actorId: principal.actorId },
        principal.documentId,
      )
      database
        .prepare(
          'INSERT INTO operations (document_id, op_id, sequence, actor_id, input, committed) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          operation.documentId,
          operation.opId,
          committed.serverSequence,
          principal.actorId,
          JSON.stringify(operation),
          JSON.stringify(committed),
        )
      database
        .prepare(
          'INSERT INTO documents (id, cursor, snapshot) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, snapshot = excluded.snapshot',
        )
        .run(operation.documentId, committed.serverSequence, JSON.stringify(model))
      database.exec('COMMIT')
      return committed
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const compact = (documentId: string, through: number): void => {
    const { cursor } = readSnapshot(documentId)
    if (!Number.isSafeInteger(through) || through < compactBefore(documentId) || through > cursor)
      throw new Error('Invalid compaction cursor')
    database.exec('BEGIN IMMEDIATE')
    try {
      // Keep the identity rows so a retransmission stays idempotent; drop the
      // payloads, which the snapshot already folds in. Re-appending a compacted
      // operation is answered from its identity and changes no state.
      database
        .prepare(
          'UPDATE operations SET input = NULL, committed = NULL WHERE document_id = ? AND sequence <= ?',
        )
        .run(documentId, through)
      database
        .prepare('UPDATE documents SET compact_before = ? WHERE id = ?')
        .run(through, documentId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const read = (documentId: string, after: number): ReadonlyArray<Committed> => {
    if (!Number.isSafeInteger(after) || after < 0 || after > readSnapshot(documentId).cursor)
      throw new Error('Invalid cursor')
    return database
      .prepare(
        'SELECT committed FROM operations WHERE document_id = ? AND sequence > ? AND committed IS NOT NULL ORDER BY sequence',
      )
      .all(documentId, after)
      .map(row => committedFrom(JSON.parse(String(row.committed)), documentId))
  }
  return {
    append,
    read,
    compact,
    snapshot: readSnapshot,
    transport: (principal: Principal): Transport => ({
      exchange: async (cursor, pending) => {
        if (!principal.actorId) throw new Error('Unauthenticated reader')
        const rejected: string[] = []
        const acknowledged: string[] = []
        for (const input of pending) {
          // Validation and identity conflicts fail the exchange; an authorization
          // refusal is a policy answer, so it removes the outbox entry instead.
          const operation = operationFrom(input, principal.documentId)
          if (!principal.canWrite) {
            rejected.push(operation.opId)
            continue
          }
          try {
            acknowledged.push(append(operation, principal).opId)
          } catch (error) {
            if (error instanceof OperationRejectedError) rejected.push(error.opId)
            else throw error
          }
        }
        // The replica's range predates the compacted payloads, so the log cannot
        // fill it in; hand back the snapshot. Pending was still appended above
        // and is acknowledged, so nothing the replica authored is replayed onto
        // the snapshot it is about to adopt.
        if (cursor < compactBefore(principal.documentId)) {
          const { cursor: at, model } = readSnapshot(principal.documentId)
          return { checkpoint: { cursor: at, model }, operations: [], rejected, acknowledged }
        }
        return { operations: read(principal.documentId, cursor), rejected, acknowledged }
      },
    }),
    close: () => database.close(),
  }
}
