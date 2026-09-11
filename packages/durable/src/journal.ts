import { createHash } from 'node:crypto'
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import {
  Config,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Stream,
  SynchronizedRef,
  type Scope,
} from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import type { Codec } from './codec.js'
import { actorId as toActorId, type ActorId, type DocumentId, type OpId } from './ids.js'
import {
  CompactedCursorError,
  IdentityConflictError,
  InvalidCompactionError,
  InvalidCursorError,
  InvalidOperationError,
  JournalError,
  OperationRejectedError,
} from './errors.js'

const SCHEMA_VERSION = 2

/** Counters an application can scrape; the default registry already collects them. */
export const journalMetrics = {
  appends: Metric.counter('foldkit_durable_appends_total'),
  compactions: Metric.counter('foldkit_durable_compactions_total'),
  /** Owner runs only; a joined or recorded call is counted as coalesced instead. */
  effectRuns: Metric.counter('foldkit_durable_effect_runs_total'),
  effectRunsCoalesced: Metric.counter('foldkit_durable_effect_runs_coalesced_total'),
}

/** An operation as the journal committed it, with its authoritative order and actor. */
export interface Committed<Operation> {
  readonly operation: Operation
  readonly sequence: number
  readonly actorId: ActorId
}

/** Structural checks that run before a commit and throw when the operation is invalid. */
export interface ValidationRequest<Operation, Snapshot, Principal> {
  readonly key: DocumentId
  readonly principal: Principal
  readonly operation: Operation
  readonly snapshot: Snapshot
  readonly cursor: number
}

/** The application's policy decision for an operation, against the authoritative snapshot. */
export interface AuthorizationRequest<Operation, Snapshot, Principal> {
  readonly key: DocumentId
  readonly principal: Principal
  readonly operation: Operation
  readonly snapshot: Snapshot
}

export interface JournalOptions<Operation, Snapshot, Principal> {
  /**
   * A `node:sqlite` path, or `:memory:`. A `Config` lets an application supply
   * the path as a layer instead of a literal.
   */
  readonly file: string | Config.Config<string>
  readonly operation: Codec<Operation>
  readonly snapshot: Codec<Snapshot>
  readonly empty: () => Snapshot
  /** Deterministic: the application's own reducer, not the journal's. */
  readonly reduce: (snapshot: Snapshot, operation: Operation) => Snapshot
  /** Stable identity; a repeat is answered idempotently. */
  readonly opId: (operation: Operation) => OpId
  /** The trusted actor recorded for the commit. */
  readonly actorId: (principal: Principal) => ActorId
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

/**
 * The outcome of `append`. `AlreadyCommitted` means the operation is known but
 * its payload was compacted away, so no `Committed` operation can be returned;
 * a caller must not treat the retransmitted content as the committed one.
 */
export type AppendResult<Operation> =
  | { readonly _tag: 'Committed'; readonly committed: Committed<Operation> }
  | {
      readonly _tag: 'AlreadyCommitted'
      readonly opId: OpId
      readonly sequence: number
      readonly actorId: ActorId
    }

export interface Journal<Operation, Snapshot, Principal> {
  readonly load: (
    key: DocumentId,
  ) => Effect.Effect<{ readonly snapshot: Snapshot; readonly cursor: number }, JournalError>
  /** The highest sequence whose payload has been compacted away; `0` if none. */
  readonly floor: (key: DocumentId) => Effect.Effect<number, JournalError>
  readonly read: (
    key: DocumentId,
    after: number,
  ) => Effect.Effect<
    ReadonlyArray<Committed<Operation>>,
    InvalidCursorError | CompactedCursorError | JournalError
  >
  /**
   * Commits an operation. A repeat of a known `opId` returns `Committed` with the
   * stored operation while its payload is retained, and `AlreadyCommitted`
   * without one once compaction has removed it. A reuse with different data or
   * actor is an `IdentityConflictError` in either case, proven by a retained
   * payload hash.
   */
  readonly append: (
    key: DocumentId,
    input: unknown,
    principal: Principal,
  ) => Effect.Effect<AppendResult<Operation>, AppendError>
  readonly compact: (
    key: DocumentId,
    through: number,
  ) => Effect.Effect<void, InvalidCompactionError | JournalError>
  /** The recorded effect for a key, if it has ever run. */
  readonly effect: (key: string) => Effect.Effect<Option.Option<EffectRecord>, JournalError>
  /**
   * Reuses recorded successes and shares concurrent runs within this journal
   * instance. Pending and failed records are retried when called again.
   * An external action can succeed before its result is recorded; recovery
   * requires provider idempotency or reconciliation. Use a stable key including
   * the document, operation, and semantic effect identity, and pass that same
   * key to the provider. Results must be JSON-compatible. See the README's
   * effect recovery policy before retrying work with uncertain outcomes.
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

/** A compacted operation keeps this instead of its payload, so identity is provable. */
const hashPayload = (encoded: string): string => createHash('sha256').update(encoded).digest('hex')

const journalError = (message: string, cause: unknown): JournalError =>
  new JournalError({ message, cause })

const resolveFile = (file: string | Config.Config<string>): Effect.Effect<string, JournalError> =>
  typeof file === 'string'
    ? Effect.succeed(file)
    : file.pipe(Effect.mapError(cause => journalError('Could not read the journal file', cause)))

const isAppendError = (error: unknown): error is AppendError =>
  error instanceof InvalidOperationError ||
  error instanceof OperationRejectedError ||
  error instanceof IdentityConflictError

/**
 * Opens a durable, ordered operation log with a snapshot and cursor per key.
 *
 * Append is atomic and idempotent by `opId`; committed order is stable; the
 * snapshot and cursor are consistent; and compaction drops payloads without
 * changing what a replay of the compacted prefix would produce. The journal
 * understands storage and ordering, never application semantics: `reduce` is
 * the application's own transition function. The SQLite connection is released
 * when the effect's scope closes.
 */
export const makeJournal = <Operation, Snapshot, Principal>(
  options: JournalOptions<Operation, Snapshot, Principal>,
): Effect.Effect<Journal<Operation, Snapshot, Principal>, JournalError, Scope.Scope> =>
  Effect.gen(function* () {
    const file = yield* resolveFile(options.file)
    // Build the driver into the journal's own scope, not the transient scope of
    // this effect, so the connection outlives `makeJournal`.
    const context = yield* Layer.build(SqliteClient.layer({ filename: file }))
    return yield* makeShapeEffect(options).pipe(Effect.provide(context))
  })

/**
 * The journal as a service, so an application composes it with `Effect.provide`
 * instead of threading the shape through its own wiring.
 */
export const JournalService = <Operation, Snapshot, Principal>() =>
  Context.Service<
    Journal<Operation, Snapshot, Principal>,
    Journal<Operation, Snapshot, Principal>
  >()('foldkit-durable/Journal')

/** Provides the journal as a scoped layer, releasing the database when the layer closes. */
export const makeJournalLayer = <Operation, Snapshot, Principal>(
  options: JournalOptions<Operation, Snapshot, Principal>,
): Layer.Layer<Journal<Operation, Snapshot, Principal>, JournalError> =>
  Layer.effect(JournalService<Operation, Snapshot, Principal>(), makeJournal(options))

const makeShapeEffect = <Operation, Snapshot, Principal>(
  options: JournalOptions<Operation, Snapshot, Principal>,
): Effect.Effect<
  Journal<Operation, Snapshot, Principal>,
  JournalError,
  SqlClient.SqlClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* migrate(sql)
    const changes = yield* PubSub.unbounded<string>()
    // Ending the journal ends its subscription stream, so a forked subscriber
    // cannot outlive the connection.
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
    const inFlight = yield* SynchronizedRef.make(
      new Map<string, Deferred.Deferred<unknown, unknown>>(),
    )
    return makeShape(sql, options, changes, inFlight)
  })

/** Creates or upgrades the tables in one transaction, keyed by `user_version`. */
const migrate = (sql: SqlClient.SqlClient): Effect.Effect<void, JournalError> =>
  Effect.gen(function* () {
    const version = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`
    const current = version[0]?.user_version ?? 0
    if (current >= SCHEMA_VERSION) return
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (current < 1) {
          yield* sql`CREATE TABLE IF NOT EXISTS documents (
            key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
            compact_before INTEGER NOT NULL DEFAULT 0
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS operations (
            key TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            actor_id TEXT NOT NULL, input TEXT,
            PRIMARY KEY (key, op_id), UNIQUE (key, sequence)
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS effects (
            key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, error TEXT
          )`
        }
        if (current < 2) {
          yield* sql`ALTER TABLE operations ADD COLUMN payload_hash TEXT`
          // Backfill identities for operations retained from before this column
          // existed, so a later retransmission can still prove its payload. SHA-256
          // is not available in SQL, so the rows are hashed in JavaScript.
          const retained = yield* sql<{
            readonly key: string
            readonly op_id: string
            readonly input: string
          }>`SELECT key, op_id, input FROM operations WHERE input IS NOT NULL`
          yield* Effect.forEach(
            retained,
            row =>
              sql`UPDATE operations SET payload_hash = ${hashPayload(String(row.input))} WHERE key = ${row.key} AND op_id = ${row.op_id}`,
            { discard: true },
          )
        }
        // A literal, not a bound parameter: SQLite rejects a placeholder in a
        // PRAGMA assignment. Keep in step with SCHEMA_VERSION.
        yield* sql`PRAGMA user_version = 2`
      }),
    )
  }).pipe(Effect.mapError(error => journalError('Could not migrate the journal', error)))

interface DocumentRow {
  readonly cursor: number
  readonly snapshot: string
  readonly compact_before: number
}

interface OperationRow {
  readonly actor_id: string
  readonly sequence: number
  readonly input: string | null
  readonly payload_hash: string | null
}

interface EffectRow {
  readonly key: string
  readonly status: string
  readonly result: string | null
  readonly error: string | null
}

const makeShape = <Operation, Snapshot, Principal>(
  sql: SqlClient.SqlClient,
  options: JournalOptions<Operation, Snapshot, Principal>,
  changes: PubSub.PubSub<string>,
  inFlight: SynchronizedRef.SynchronizedRef<Map<string, Deferred.Deferred<unknown, unknown>>>,
): Journal<Operation, Snapshot, Principal> => {
  type Shape = Journal<Operation, Snapshot, Principal>

  const decodeSnapshot = (row: DocumentRow | undefined): { snapshot: Snapshot; cursor: number } =>
    row === undefined
      ? { snapshot: options.empty(), cursor: 0 }
      : {
          snapshot: options.snapshot.decode(JSON.parse(String(row.snapshot))),
          cursor: Number(row.cursor),
        }

  const load: Shape['load'] = Effect.fn('Journal.load')(function* (key: DocumentId) {
    yield* Effect.annotateCurrentSpan({ key })
    const rows =
      yield* sql<DocumentRow>`SELECT cursor, snapshot FROM documents WHERE key = ${key}`.pipe(
        Effect.mapError(cause => journalError('Could not load the snapshot', cause)),
      )
    return yield* Effect.try({
      try: () => decodeSnapshot(rows[0]),
      catch: cause => journalError('Could not load the snapshot', cause),
    })
  })

  const floor: Shape['floor'] = Effect.fn('Journal.floor')(function* (key: DocumentId) {
    yield* Effect.annotateCurrentSpan({ key })
    const rows = yield* sql<{
      readonly compact_before: number
    }>`SELECT compact_before FROM documents WHERE key = ${key}`.pipe(
      Effect.mapError(cause => journalError('Could not read the compaction floor', cause)),
    )
    return rows[0]?.compact_before ?? 0
  })

  const read: Shape['read'] = Effect.fn('Journal.read')(function* (key: DocumentId, after: number) {
    yield* Effect.annotateCurrentSpan({ key, after })
    const documents = yield* sql<{
      readonly cursor: number
      readonly compact_before: number
    }>`SELECT cursor, compact_before FROM documents WHERE key = ${key}`.pipe(
      Effect.mapError(cause => journalError('Could not read the log', cause)),
    )
    const cursor = documents[0]?.cursor ?? 0
    if (!Number.isSafeInteger(after) || after < 0 || after > cursor)
      return yield* Effect.fail(
        new InvalidCursorError({
          after,
          cursor,
          message: `Cursor ${after} is outside [0, ${cursor}]`,
        }),
      )
    // Compaction removes the payloads a cursor below the floor would need. Fail
    // closed rather than returning a tail that silently starts late.
    const floor = documents[0]?.compact_before ?? 0
    if (after < floor)
      return yield* Effect.fail(
        new CompactedCursorError({
          after,
          floor,
          cursor,
          message: `Cursor ${after} is below the compaction floor ${floor}`,
        }),
      )
    const rows =
      yield* sql<OperationRow>`SELECT actor_id, sequence, input FROM operations WHERE key = ${key} AND sequence > ${after} AND input IS NOT NULL ORDER BY sequence`.pipe(
        Effect.mapError(cause => journalError('Could not read the log', cause)),
      )
    return yield* Effect.try({
      try: () =>
        rows.map(row => ({
          operation: options.operation.decode(JSON.parse(String(row.input))),
          sequence: Number(row.sequence),
          actorId: toActorId(String(row.actor_id)),
        })),
      catch: cause => journalError('Could not read the log', cause),
    })
  })

  const append: Shape['append'] = Effect.fn('Journal.append')(function* (
    key: DocumentId,
    input: unknown,
    principal: Principal,
  ) {
    const operation = yield* Effect.try({
      try: () => options.operation.decode(input),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })
    const opId = yield* Effect.try({
      try: () => options.opId(operation),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })
    yield* Effect.annotateCurrentSpan({ key, opId })
    const actorId = yield* Effect.try({
      try: () => options.actorId(principal),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(options.operation.encode(operation)),
      catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
    })

    const payloadHash = hashPayload(encoded)
    const conflict = (): IdentityConflictError =>
      new IdentityConflictError({
        opId,
        message: `Operation "${opId}" was reused with different data or actor`,
      })

    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior =
            yield* sql<OperationRow>`SELECT actor_id, sequence, input, payload_hash FROM operations WHERE key = ${key} AND op_id = ${opId}`
          if (prior.length > 0) {
            const row = prior[0]!
            const sequence = Number(row.sequence)
            const priorActor = toActorId(String(row.actor_id))
            if (row.input !== null) {
              // The payload is retained, so the committed operation is canonical.
              if (row.input !== encoded || priorActor !== actorId)
                return yield* Effect.fail(conflict())
              const operation = yield* Effect.try({
                try: () => options.operation.decode(JSON.parse(String(row.input))),
                catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
              })
              return {
                result: {
                  _tag: 'Committed' as const,
                  committed: { operation, sequence, actorId: priorActor },
                },
                changed: false,
              }
            }
            // The payload was compacted away. Answer idempotently from the stored
            // identity, but never rebuild a committed operation from the
            // retransmitted content: it may not be what was committed.
            if (
              priorActor !== actorId ||
              (row.payload_hash !== null && row.payload_hash !== payloadHash)
            )
              return yield* Effect.fail(conflict())
            return {
              result: { _tag: 'AlreadyCommitted' as const, opId, sequence, actorId: priorActor },
              changed: false,
            }
          }
          const documents =
            yield* sql<DocumentRow>`SELECT cursor, snapshot FROM documents WHERE key = ${key}`
          const { snapshot, cursor } = yield* Effect.try({
            try: () => decodeSnapshot(documents[0]),
            catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
          })
          yield* Effect.try({
            try: () => options.validate?.({ key, principal, operation, snapshot, cursor }),
            catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
          })
          const allowed = yield* Effect.try({
            try: () => options.authorize?.({ key, principal, operation, snapshot }) ?? true,
            catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
          })
          if (!allowed)
            return yield* Effect.fail(
              new OperationRejectedError({
                opId,
                message: `Operation "${opId}" was refused by authorization`,
              }),
            )
          const reduced = yield* Effect.try({
            try: () => options.reduce(snapshot, operation),
            catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
          })
          const sequence = cursor + 1
          const encodedSnapshot = yield* Effect.try({
            try: () => JSON.stringify(options.snapshot.encode(reduced)),
            catch: cause => new InvalidOperationError({ message: 'Invalid operation', cause }),
          })
          yield* sql`INSERT INTO operations (key, op_id, sequence, actor_id, input, payload_hash) VALUES (${key}, ${opId}, ${sequence}, ${actorId}, ${encoded}, ${payloadHash})`
          yield* sql`INSERT INTO documents (key, cursor, snapshot) VALUES (${key}, ${sequence}, ${encodedSnapshot}) ON CONFLICT(key) DO UPDATE SET cursor = excluded.cursor, snapshot = excluded.snapshot`
          return {
            result: {
              _tag: 'Committed' as const,
              committed: { operation, sequence, actorId },
            },
            changed: true,
          }
        }),
      )
      .pipe(
        Effect.mapError(error =>
          isAppendError(error) ? error : journalError('Could not append the operation', error),
        ),
      )

    // Publish and observe only after the transaction committed, so a subscriber
    // never sees a change that could still roll back.
    if (outcome.changed && outcome.result._tag === 'Committed') {
      yield* Metric.update(journalMetrics.appends, 1)
      yield* Effect.logDebug('journal append', {
        key,
        opId,
        sequence: outcome.result.committed.sequence,
      })
      yield* PubSub.publish(changes, key)
    }
    return outcome.result
  })

  const compact: Shape['compact'] = Effect.fn('Journal.compact')(function* (
    key: DocumentId,
    through: number,
  ) {
    yield* Effect.annotateCurrentSpan({ key, through })
    yield* Effect.gen(function* () {
      const documents = yield* sql<{
        readonly cursor: number
        readonly compact_before: number
      }>`SELECT cursor, compact_before FROM documents WHERE key = ${key}`
      const cursor = documents[0]?.cursor ?? 0
      const compactBefore = documents[0]?.compact_before ?? 0
      if (!Number.isSafeInteger(through) || through < compactBefore || through > cursor)
        return yield* Effect.fail(
          new InvalidCompactionError({
            through,
            message: `Cannot compact "${key}" through ${through}`,
          }),
        )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE operations SET input = NULL WHERE key = ${key} AND sequence <= ${through}`
          yield* sql`UPDATE documents SET compact_before = ${through} WHERE key = ${key}`
        }),
      )
    }).pipe(
      Effect.mapError(error =>
        error instanceof InvalidCompactionError ? error : journalError('Could not compact', error),
      ),
    )
    yield* Metric.update(journalMetrics.compactions, 1)
    yield* Effect.logDebug('journal compact', { key, through })
  })

  const effect: Shape['effect'] = Effect.fn('Journal.effect')(function* (key: string) {
    yield* Effect.annotateCurrentSpan({ key })
    const rows =
      yield* sql<EffectRow>`SELECT key, status, result, error FROM effects WHERE key = ${key}`.pipe(
        Effect.mapError(cause => journalError('Could not read the effect record', cause)),
      )
    const row = rows[0]
    if (row === undefined) return Option.none<EffectRecord>()
    return yield* Effect.try({
      try: () =>
        Option.some({
          key: String(row.key),
          status: String(row.status) as EffectStatus,
          ...(row.result === null ? {} : { result: JSON.parse(String(row.result)) }),
          ...(row.error === null ? {} : { error: String(row.error) }),
        }),
      catch: cause => journalError('Could not read the effect record', cause),
    })
  })

  const record = (
    key: string,
    status: EffectStatus,
    result: unknown,
    error: string | undefined,
  ): Effect.Effect<void, JournalError> =>
    Effect.gen(function* () {
      // Encode before the statement so a non-serializable result is a typed
      // failure, not a defect.
      const encoded = yield* Effect.try({
        try: () => (result === undefined ? null : JSON.stringify(result)),
        catch: cause => journalError('Could not record the effect', cause),
      })
      yield* sql`INSERT INTO effects (key, status, result, error) VALUES (${key}, ${status}, ${encoded}, ${error ?? null}) ON CONFLICT(key) DO UPDATE SET status = excluded.status, result = excluded.result, error = excluded.error`.pipe(
        Effect.mapError(cause => journalError('Could not record the effect', cause)),
      )
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
      if (!entry.owner) {
        yield* Metric.update(journalMetrics.effectRunsCoalesced, 1)
        return yield* Deferred.await(entry.deferred) as Effect.Effect<Result, E | JournalError>
      }

      return yield* Effect.gen(function* () {
        const recorded = yield* effect(key)
        if (Option.isSome(recorded) && recorded.value.status === 'succeeded') {
          yield* Metric.update(journalMetrics.effectRunsCoalesced, 1)
          return recorded.value.result as Result
        }

        yield* Metric.update(journalMetrics.effectRuns, 1)
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
