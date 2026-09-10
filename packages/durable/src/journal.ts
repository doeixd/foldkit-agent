import { createRequire } from 'node:module'
import type { Codec } from './codec.js'

// Vite 5's module resolver predates the node:sqlite built-in.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

/** An operation as the journal committed it, with its authoritative order and actor. */
export interface Committed<Operation> {
  readonly operation: Operation
  readonly sequence: number
  readonly actorId: string
}

/** Structural checks that run before a commit and throw when the operation is invalid. */
export interface ValidationRequest<Operation, Snapshot, Principal> {
  readonly key: string
  readonly principal: Principal
  readonly operation: Operation
  readonly snapshot: Snapshot
  readonly cursor: number
}

/** The application's policy decision for an operation, against the authoritative snapshot. */
export interface AuthorizationRequest<Operation, Snapshot, Principal> {
  readonly key: string
  readonly principal: Principal
  readonly operation: Operation
  readonly snapshot: Snapshot
}

export interface JournalOptions<Operation, Snapshot, Principal> {
  /** A `node:sqlite` path, or `:memory:`. */
  readonly file: string
  readonly operation: Codec<Operation>
  readonly snapshot: Codec<Snapshot>
  readonly empty: () => Snapshot
  /** Deterministic: the application's own reducer, not the journal's. */
  readonly reduce: (snapshot: Snapshot, operation: Operation) => Snapshot
  /** Stable identity; a repeat is answered idempotently. */
  readonly opId: (operation: Operation) => string
  /** The trusted actor recorded for the commit. */
  readonly actorId: (principal: Principal) => string
  readonly validate?: (request: ValidationRequest<Operation, Snapshot, Principal>) => void
  readonly authorize?: (request: AuthorizationRequest<Operation, Snapshot, Principal>) => boolean
}

/** The application's policy refused an operation; nothing was committed. */
export class OperationRejectedError extends Error {
  override readonly name = 'OperationRejectedError'
  constructor(readonly opId: string) {
    super(`Operation "${opId}" was refused by authorization`)
  }
}

export interface Journal<Operation, Snapshot, Principal> {
  load(key: string): { readonly snapshot: Snapshot; readonly cursor: number }
  /** The highest sequence whose payload has been compacted away; `0` if none. */
  floor(key: string): number
  read(key: string, after: number): ReadonlyArray<Committed<Operation>>
  append(key: string, input: unknown, principal: Principal): Committed<Operation>
  compact(key: string, through: number): void
  /** Notified after each commit that changed a snapshot, with the key. */
  subscribe(listener: (key: string) => void): () => void
  close(): void
}

/**
 * A durable, ordered operation log with a snapshot and cursor per key.
 *
 * Append is atomic and idempotent by `opId`; committed order is stable; the
 * snapshot and cursor are consistent; and compaction drops payloads without
 * changing what a replay of the compacted prefix would produce. The journal
 * understands storage and ordering, never application semantics: `reduce` is
 * the application's own transition function.
 */
export const createJournal = <Operation, Snapshot, Principal>(
  options: JournalOptions<Operation, Snapshot, Principal>,
): Journal<Operation, Snapshot, Principal> => {
  const database = new DatabaseSync(options.file)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
      compact_before INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS operations (
      key TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      actor_id TEXT NOT NULL, input TEXT,
      PRIMARY KEY (key, op_id), UNIQUE (key, sequence)
    );
  `)
  const load = (key: string): { snapshot: Snapshot; cursor: number } => {
    const row = database.prepare('SELECT cursor, snapshot FROM documents WHERE key = ?').get(key)
    return row === undefined
      ? { snapshot: options.empty(), cursor: 0 }
      : {
          snapshot: options.snapshot.decode(JSON.parse(String(row.snapshot))),
          cursor: Number(row.cursor),
        }
  }
  const compactBefore = (key: string): number => {
    const row = database.prepare('SELECT compact_before FROM documents WHERE key = ?').get(key)
    return row === undefined ? 0 : Number(row.compact_before)
  }
  const listeners = new Set<(key: string) => void>()
  /** A subscriber must never fail a commit. */
  const notify = (key: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(key)
      } catch {
        // Deliberately swallowed.
      }
    }
  }
  const append = (key: string, input: unknown, principal: Principal): Committed<Operation> => {
    const operation = options.operation.decode(input)
    const opId = options.opId(operation)
    const actorId = options.actorId(principal)
    const encoded = JSON.stringify(options.operation.encode(operation))
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database
        .prepare('SELECT actor_id, sequence, input FROM operations WHERE key = ? AND op_id = ?')
        .get(key, opId)
      if (prior !== undefined) {
        // A compacted operation keeps its identity row but loses its payload.
        // A retransmission is still answered from that identity -- the snapshot
        // already folded it in, so nothing is replayed a second time.
        const committed: Committed<Operation> = {
          operation:
            prior.input === null
              ? operation
              : options.operation.decode(JSON.parse(String(prior.input))),
          sequence: Number(prior.sequence),
          actorId: String(prior.actor_id),
        }
        // Only a retained payload can prove an identity conflict. After
        // compaction the operation is acknowledged without being re-applied.
        if (prior.input !== null && (prior.input !== encoded || committed.actorId !== actorId))
          throw new Error('Operation identity conflict')
        database.exec('COMMIT')
        return committed
      }
      const { snapshot, cursor } = load(key)
      options.validate?.({ key, principal, operation, snapshot, cursor })
      if (
        options.authorize !== undefined &&
        !options.authorize({ key, principal, operation, snapshot })
      )
        throw new OperationRejectedError(opId)
      const reduced = options.reduce(snapshot, operation)
      const sequence = cursor + 1
      database
        .prepare(
          'INSERT INTO operations (key, op_id, sequence, actor_id, input) VALUES (?, ?, ?, ?, ?)',
        )
        .run(key, opId, sequence, actorId, encoded)
      database
        .prepare(
          'INSERT INTO documents (key, cursor, snapshot) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, snapshot = excluded.snapshot',
        )
        .run(key, sequence, JSON.stringify(options.snapshot.encode(reduced)))
      database.exec('COMMIT')
      // Announced only when the snapshot changed; a duplicate append changed nothing.
      notify(key)
      return { operation, sequence, actorId }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const compact = (key: string, through: number): void => {
    const { cursor } = load(key)
    if (!Number.isSafeInteger(through) || through < compactBefore(key) || through > cursor)
      throw new Error('Invalid compaction cursor')
    database.exec('BEGIN IMMEDIATE')
    try {
      // Keep the identity rows so a retransmission stays idempotent; drop the
      // payloads, which the snapshot already folds in.
      database
        .prepare('UPDATE operations SET input = NULL WHERE key = ? AND sequence <= ?')
        .run(key, through)
      database.prepare('UPDATE documents SET compact_before = ? WHERE key = ?').run(through, key)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const read = (key: string, after: number): ReadonlyArray<Committed<Operation>> => {
    if (!Number.isSafeInteger(after) || after < 0 || after > load(key).cursor)
      throw new Error('Invalid cursor')
    return database
      .prepare(
        'SELECT actor_id, sequence, input FROM operations WHERE key = ? AND sequence > ? AND input IS NOT NULL ORDER BY sequence',
      )
      .all(key, after)
      .map(row => ({
        operation: options.operation.decode(JSON.parse(String(row.input))),
        sequence: Number(row.sequence),
        actorId: String(row.actor_id),
      }))
  }
  const subscribe = (listener: (key: string) => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    load,
    floor: compactBefore,
    read,
    append,
    compact,
    subscribe,
    close: () => database.close(),
  }
}
