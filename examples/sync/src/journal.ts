import { createRequire } from 'node:module'
import { decodeShared, decodeMessage, replay, type Shared } from './app.js'
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

export const openJournal = (path: string) => {
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (
      document_id TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      input TEXT NOT NULL, committed TEXT NOT NULL,
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
  const append = (input: unknown, principal: Principal): Committed => {
    const operation = operationFrom(input, principal.documentId)
    if (!principal.actorId || !principal.canWrite) throw new Error('Unauthorized operation')
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database
        .prepare('SELECT input, committed FROM operations WHERE document_id = ? AND op_id = ?')
        .get(operation.documentId, operation.opId)
      if (prior !== undefined) {
        const committed = committedFrom(JSON.parse(String(prior.committed)), principal.documentId)
        if (prior.input !== JSON.stringify(operation) || committed.actorId !== principal.actorId)
          throw new Error('Operation identity conflict')
        database.exec('COMMIT')
        return committed
      }
      const snapshot = readSnapshot(operation.documentId)
      if (operation.baseCursor > snapshot.cursor)
        throw new Error('Operation cursor is ahead of the server')
      const model = replay(snapshot.model, decodeMessage(operation.message))
      const committed = committedFrom(
        { ...operation, serverSequence: snapshot.cursor + 1, actorId: principal.actorId },
        principal.documentId,
      )
      database
        .prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?)')
        .run(
          operation.documentId,
          operation.opId,
          committed.serverSequence,
          JSON.stringify(operation),
          JSON.stringify(committed),
        )
      database
        .prepare(
          'INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, snapshot = excluded.snapshot',
        )
        .run(operation.documentId, committed.serverSequence, JSON.stringify(model))
      database.exec('COMMIT')
      return committed
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
        'SELECT committed FROM operations WHERE document_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(documentId, after)
      .map(row => committedFrom(JSON.parse(String(row.committed)), documentId))
  }
  return {
    append,
    read,
    snapshot: readSnapshot,
    transport: (principal: Principal): Transport => ({
      exchange: async (cursor, pending) => {
        if (!principal.actorId) throw new Error('Unauthenticated reader')
        const rejected: string[] = []
        for (const input of pending) {
          // Validation and identity conflicts fail the exchange; only policy refusals remove an outbox entry.
          const operation = operationFrom(input, principal.documentId)
          if (!principal.canWrite) rejected.push(operation.opId)
          else append(operation, principal)
        }
        return { operations: read(principal.documentId, cursor), rejected }
      },
    }),
    close: () => database.close(),
  }
}
