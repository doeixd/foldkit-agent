import { createRequire } from 'node:module'
import { Deferred, Effect, Exit, Option, PubSub, Stream, SynchronizedRef, type Scope } from 'effect'
import type { Codec } from './codec.js'
import {
  IdentityConflictError,
  InvalidCompactionError,
  InvalidCursorError,
  InvalidOperationError,
  JournalError,
  OperationRejectedError,
} from './errors.js'

// Vite 5's module resolver predates the node:sqlite built-in.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

const SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS effects (
    key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, error TEXT
  );
`

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

export type EffectStatus = 'pending' | 'succeeded' | 'failed'

/** The durable record of one externally visible effect. */
export interface EffectRecord {
  readonly key: string
  readonly status: EffectStatus
  readonly result?: unknown
  readonly error?: string
}

export type AppendError =
  InvalidOperationError | OperationRejectedError | IdentityConflictError | JournalError

export interface Journal<Operation, Snapshot, Principal> {
  readonly load: (
    key: string,
  ) => Effect.Effect<{ readonly snapshot: Snapshot; readonly cursor: number }, JournalError>
  /** The highest sequence whose payload has been compacted away; `0` if none. */
  readonly floor: (key: string) => Effect.Effect<number, JournalError>
  readonly read: (
    key: string,
    after: number,
  ) => Effect.Effect<ReadonlyArray<Committed<Operation>>, InvalidCursorError | JournalError>
  readonly append: (
    key: string,
    input: unknown,
    principal: Principal,
  ) => Effect.Effect<Committed<Operation>, AppendError>
  readonly compact: (
    key: string,
    through: number,
  ) => Effect.Effect<void, InvalidCompactionError | JournalError>
  /** The recorded effect for a key, if it has ever run. */
  readonly effect: (key: string) => Effect.Effect<Option.Option<EffectRecord>, JournalError>
  /**
   * Runs an externally visible effect at most once per key, recording the
   * outcome durably.
   *
   * A second call after success returns the recorded result without running
   * again; a concurrent call awaits the run already in flight; a failed run is
   * left recorded and may be retried. Key it by the operation that caused it,
   * for example `opId + "/command/" + index`, so a replay or restart cannot
   * duplicate the effect. The result must be JSON-compatible.
   */
  readonly runEffect: <Result, E>(
    key: string,
    run: Effect.Effect<Result, E>,
  ) => Effect.Effect<Result, E | JournalError>
  /**
   * The document keys a commit changed. Subscription is a `Stream`, so a
   * subscriber never fails or slows a commit; a caller that needs a callback
   * adapts it at the edge.
   */
  readonly subscribe: Stream.Stream<string>
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const journalError = (message: string, cause: unknown): JournalError =>
  new JournalError({ message, cause })

/**
 * Opens a durable, ordered operation log with a snapshot and cursor per key.
 *
 * Append is atomic and idempotent by `opId`; committed order is stable; the
 * snapshot and cursor are consistent; and compaction drops payloads without
 * changing what a replay of the compacted prefix would produce. The journal
 * understands storage and ordering, never application semantics: `reduce` is
 * the application's own transition function. The database is released when the
 * effect's scope closes.
 */
export const makeJournal = <Operation, Snapshot, Principal>(
  options: JournalOptions<Operation, Snapshot, Principal>,
): Effect.Effect<Journal<Operation, Snapshot, Principal>, JournalError, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const database = new DatabaseSync(options.file)
          try {
            database.exec(SCHEMA)
          } catch (error) {
            database.close()
            throw error
          }
          return database
        },
        catch: cause => journalError('Could not open the journal', cause),
      }),
      database => Effect.sync(() => database.close()),
    )
    const changes = yield* PubSub.unbounded<string>()
    const inFlight = yield* SynchronizedRef.make(
      new Map<string, Deferred.Deferred<unknown, unknown>>(),
    )
    return makeShape(database, options, changes, inFlight)
  })

const makeShape = <Operation, Snapshot, Principal>(
  database: InstanceType<typeof DatabaseSync>,
  options: JournalOptions<Operation, Snapshot, Principal>,
  changes: PubSub.PubSub<string>,
  inFlight: SynchronizedRef.SynchronizedRef<Map<string, Deferred.Deferred<unknown, unknown>>>,
): Journal<Operation, Snapshot, Principal> => {
  type Shape = Journal<Operation, Snapshot, Principal>

  const load: Shape['load'] = Effect.fn('Journal.load')(function* (key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    return yield* Effect.try({
      try: () => {
        const row = database
          .prepare('SELECT cursor, snapshot FROM documents WHERE key = ?')
          .get(key)
        return row === undefined
          ? { snapshot: options.empty(), cursor: 0 }
          : {
              snapshot: options.snapshot.decode(JSON.parse(String(row.snapshot))),
              cursor: Number(row.cursor),
            }
      },
      catch: cause => journalError('Could not load the snapshot', cause),
    })
  })

  const compactBefore = (key: string): number => {
    const row = database.prepare('SELECT compact_before FROM documents WHERE key = ?').get(key)
    return row === undefined ? 0 : Number(row.compact_before)
  }

  const cursorOf = (key: string): number => {
    const row = database.prepare('SELECT cursor FROM documents WHERE key = ?').get(key)
    return row === undefined ? 0 : Number(row.cursor)
  }

  const floor: Shape['floor'] = Effect.fn('Journal.floor')(function* (key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    return yield* Effect.try({
      try: () => compactBefore(key),
      catch: cause => journalError('Could not read the compaction floor', cause),
    })
  })

  const append: Shape['append'] = Effect.fn('Journal.append')(function* (
    key: string,
    input: unknown,
    principal: Principal,
  ) {
    const operation = yield* Effect.try({
      try: () => options.operation.decode(input),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })
    const opId = options.opId(operation)
    yield* Effect.annotateCurrentSpan({ key, opId })
    const actorId = options.actorId(principal)
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(options.operation.encode(operation)),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })
    const outcome = yield* Effect.try({
      try: () => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const prior = database
            .prepare('SELECT actor_id, sequence, input FROM operations WHERE key = ? AND op_id = ?')
            .get(key, opId)
          if (prior !== undefined) {
            // A compacted operation keeps its identity row but loses its
            // payload; a retransmission is answered from that identity.
            const committed: Committed<Operation> = {
              operation:
                prior.input === null
                  ? operation
                  : options.operation.decode(JSON.parse(String(prior.input))),
              sequence: Number(prior.sequence),
              actorId: String(prior.actor_id),
            }
            if (prior.input !== null && (prior.input !== encoded || committed.actorId !== actorId))
              throw new IdentityConflictError({
                opId,
                message: `Operation "${opId}" was reused with different data or actor`,
              })
            database.exec('COMMIT')
            return { committed, changed: false }
          }
          const { snapshot, cursor } = loadSync()
          try {
            options.validate?.({ key, principal, operation, snapshot, cursor })
          } catch (cause) {
            throw new InvalidOperationError({ message: 'Invalid operation', cause })
          }
          if (
            options.authorize !== undefined &&
            !options.authorize({ key, principal, operation, snapshot })
          )
            throw new OperationRejectedError({
              opId,
              message: `Operation "${opId}" was refused by authorization`,
            })
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
          return { committed: { operation, sequence, actorId }, changed: true }
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
      catch: (cause): AppendError => {
        if (
          cause instanceof OperationRejectedError ||
          cause instanceof IdentityConflictError ||
          cause instanceof InvalidOperationError
        )
          return cause
        return journalError('Could not append the operation', cause)
      },
    })
    // Publish only after the transaction committed, so a subscriber never
    // observes a change that could still roll back.
    if (outcome.changed) yield* PubSub.publish(changes, key)
    return outcome.committed

    function loadSync(): { snapshot: Snapshot; cursor: number } {
      const row = database.prepare('SELECT cursor, snapshot FROM documents WHERE key = ?').get(key)
      return row === undefined
        ? { snapshot: options.empty(), cursor: 0 }
        : {
            snapshot: options.snapshot.decode(JSON.parse(String(row.snapshot))),
            cursor: Number(row.cursor),
          }
    }
  })

  const compact: Shape['compact'] = Effect.fn('Journal.compact')(function* (
    key: string,
    through: number,
  ) {
    yield* Effect.annotateCurrentSpan({ key, through })
    yield* Effect.try({
      try: () => {
        const cursor = cursorOf(key)
        if (!Number.isSafeInteger(through) || through < compactBefore(key) || through > cursor)
          throw new InvalidCompactionError({
            through,
            message: `Cannot compact "${key}" through ${through}`,
          })
        database.exec('BEGIN IMMEDIATE')
        try {
          database
            .prepare('UPDATE operations SET input = NULL WHERE key = ? AND sequence <= ?')
            .run(key, through)
          database
            .prepare('UPDATE documents SET compact_before = ? WHERE key = ?')
            .run(through, key)
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
      catch: (cause): InvalidCompactionError | JournalError =>
        cause instanceof InvalidCompactionError ? cause : journalError('Could not compact', cause),
    })
  })

  const read: Shape['read'] = Effect.fn('Journal.read')(function* (key: string, after: number) {
    yield* Effect.annotateCurrentSpan({ key, after })
    return yield* Effect.try({
      try: () => {
        const cursor = cursorOf(key)
        if (!Number.isSafeInteger(after) || after < 0 || after > cursor)
          throw new InvalidCursorError({
            after,
            cursor,
            message: `Cursor ${after} is outside [0, ${cursor}]`,
          })
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
      },
      catch: (cause): InvalidCursorError | JournalError =>
        cause instanceof InvalidCursorError ? cause : journalError('Could not read the log', cause),
    })
  })

  const effect: Shape['effect'] = Effect.fn('Journal.effect')(function* (key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    return yield* Effect.try({
      try: () => {
        const row = database
          .prepare('SELECT key, status, result, error FROM effects WHERE key = ?')
          .get(key)
        if (row === undefined) return Option.none<EffectRecord>()
        return Option.some({
          key: String(row.key),
          status: String(row.status) as EffectStatus,
          ...(row.result === null ? {} : { result: JSON.parse(String(row.result)) }),
          ...(row.error === null ? {} : { error: String(row.error) }),
        })
      },
      catch: cause => journalError('Could not read the effect record', cause),
    })
  })

  const record = (
    key: string,
    status: EffectStatus,
    result: unknown,
    error: string | undefined,
  ): Effect.Effect<void, JournalError> =>
    Effect.try({
      try: () => {
        database
          .prepare(
            'INSERT INTO effects (key, status, result, error) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, result = excluded.result, error = excluded.error',
          )
          .run(key, status, result === undefined ? null : JSON.stringify(result), error ?? null)
      },
      catch: cause => journalError('Could not record the effect', cause),
    })

  const runEffect: Shape['runEffect'] = <Result, E>(key: string, run: Effect.Effect<Result, E>) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ key })
      // Check-and-reserve is one atomic step, so a concurrent call joins the
      // run already in flight instead of starting a second one.
      const entry = yield* SynchronizedRef.modify(
        inFlight,
        (
          map,
        ): readonly [
          { readonly deferred: Deferred.Deferred<unknown, unknown>; readonly owner: boolean },
          Map<string, Deferred.Deferred<unknown, unknown>>,
        ] => {
          const existing = map.get(key)
          if (existing !== undefined) return [{ deferred: existing, owner: false }, map]
          const created = Deferred.makeUnsafe<unknown, unknown>()
          const next = new Map(map)
          next.set(key, created)
          return [{ deferred: created, owner: true }, next]
        },
      )
      if (!entry.owner)
        return yield* Deferred.await(entry.deferred) as Effect.Effect<Result, E | JournalError>

      return yield* Effect.gen(function* () {
        const recorded = yield* effect(key)
        if (Option.isSome(recorded) && recorded.value.status === 'succeeded')
          return recorded.value.result as Result

        yield* record(key, 'pending', undefined, undefined)
        return yield* run.pipe(
          Effect.tap(value => record(key, 'succeeded', value, undefined)),
          Effect.tapError(error => record(key, 'failed', undefined, describe(error))),
        )
      }).pipe(
        Effect.onExit(exit =>
          Exit.isSuccess(exit)
            ? Effect.asVoid(Deferred.succeed(entry.deferred, exit.value))
            : Effect.asVoid(Deferred.failCause(entry.deferred, exit.cause)),
        ),
        Effect.ensuring(
          SynchronizedRef.update(inFlight, map => {
            const next = new Map(map)
            next.delete(key)
            return next
          }),
        ),
      )
    })

  const subscribe: Shape['subscribe'] = Stream.fromPubSub(changes)

  return { load, floor, read, append, compact, effect, runEffect, subscribe }
}
