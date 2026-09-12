import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, Deferred, Effect, Fiber, Metric, Option, Stream, type Scope } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  JournalService,
  actorId,
  cursor,
  documentId,
  journalMetrics,
  makeJournal,
  makeJournalLayer,
  opId,
  sequence,
  type AppendResult,
  type Codec,
  type Committed,
  type Journal,
  type JournalOptions,
} from '../src/index.js'

// Vite 5's builtin list predates node:sqlite; let Node resolve it directly.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite')

interface Operation {
  readonly opId: string
  readonly kind: 'add' | 'remove'
  readonly id: string
}

interface Snapshot {
  readonly ids: ReadonlyArray<string>
}

interface Principal {
  readonly actorId: string
  readonly canWrite: boolean
}

const operation: Codec<Operation> = {
  encode: value => value,
  decode: value => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid operation')
    const { opId, kind, id } = value as Record<string, unknown>
    if (typeof opId !== 'string' || (kind !== 'add' && kind !== 'remove') || typeof id !== 'string')
      throw new Error('invalid operation')
    return { opId, kind, id }
  },
}

const snapshot: Codec<Snapshot> = {
  encode: value => value,
  decode: value => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid snapshot')
    const ids = (value as { ids?: unknown }).ids
    if (!Array.isArray(ids)) throw new Error('invalid snapshot')
    return { ids: ids.map(String) }
  },
}

const add = (sequence: number, id = String(sequence)): Operation => ({
  opId: `a:${sequence}`,
  kind: 'add',
  id,
})

const remove = (sequence: number, id: string): Operation => ({
  opId: `a:${sequence}`,
  kind: 'remove',
  id,
})

const reduce = (state: Snapshot, op: Operation): Snapshot =>
  op.kind === 'add'
    ? { ids: state.ids.includes(op.id) ? state.ids : [...state.ids, op.id] }
    : { ids: state.ids.filter(id => id !== op.id) }

const principal: Principal = { actorId: 'owner', canWrite: true }

const todos = documentId('todos')
const docA = documentId('a')
const docB = documentId('b')
const missing = documentId('missing')

type Hooks = Partial<
  Pick<JournalOptions<Operation, Snapshot, Principal>, 'validate' | 'authorize' | 'reduce'>
>

const base = {
  operation,
  snapshot,
  empty: (): Snapshot => ({ ids: [] }),
  reduce,
  opId: (value: Operation) => opId(value.opId),
  actorId: (value: Principal) => actorId(value.actorId),
}

const withJournal = <A>(
  body: (
    journal: Journal<Operation, Snapshot, Principal>,
  ) => Generator<Effect.Effect<unknown, unknown, Scope.Scope>, A, unknown>,
  hooks: Hooks = {},
  file = ':memory:',
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const journal = yield* makeJournal<Operation, Snapshot, Principal>({
          file,
          ...base,
          ...hooks,
        })
        return yield* Effect.gen(() => body(journal))
      }),
    ),
  )

/** Narrows an append result that must carry the committed operation. */
const appendCommitted = (result: AppendResult<Operation>): Committed<Operation> => {
  if (result._tag !== 'Committed') throw new Error('Expected a committed operation')
  return result.committed
}

describe('a durable journal', () => {
  it('orders appends and reads them after a cursor', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1, 'a'), principal)
      yield* journal.append(todos, add(2, 'b'), principal)

      const all = yield* journal.read(todos, cursor(0))
      expect(all.map(committed => [committed.operation.opId, committed.sequence])).toEqual([
        ['a:1', 1],
        ['a:2', 2],
      ])
      const tail = yield* journal.read(todos, cursor(1))
      expect(tail.map(committed => committed.operation.opId)).toEqual(['a:2'])
      expect(yield* journal.load(todos)).toEqual({
        snapshot: { ids: ['a', 'b'] },
        cursor: 2,
      })
    }))

  it('keeps keys independent', () =>
    withJournal(function* (journal) {
      yield* journal.append(docA, add(1, 'a'), principal)
      yield* journal.append(docB, add(1, 'b'), principal)

      expect((yield* journal.load(docA)).snapshot).toEqual({ ids: ['a'] })
      expect((yield* journal.load(docB)).snapshot).toEqual({ ids: ['b'] })
    }))

  it('treats an unknown key as empty and reads nothing at the cursor', () =>
    withJournal(function* (journal) {
      const first = yield* journal.load(missing)
      const second = yield* journal.load(missing)
      expect(first).toEqual({ snapshot: { ids: [] }, cursor: 0 })
      // `empty` runs per read, so callers cannot mutate a shared default.
      expect(first.snapshot).not.toBe(second.snapshot)

      yield* journal.append(todos, add(1, 'a'), principal)
      expect(yield* journal.read(todos, cursor(1))).toEqual([])
    }))

  it('is idempotent by operation identity and rejects a conflicting reuse', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1, 'a'), principal)
      const again = appendCommitted(yield* journal.append(todos, add(1, 'a'), principal))
      expect(again.sequence).toBe(1)
      expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })

      const payload = yield* Effect.result(
        journal.append(todos, { ...add(1), id: 'different' }, principal),
      )
      expect(payload).toMatchObject({ _tag: 'Failure', failure: { _tag: 'IdentityConflictError' } })

      const actor = yield* Effect.result(
        journal.append(todos, add(1, 'a'), { actorId: 'other', canWrite: true }),
      )
      expect(actor).toMatchObject({ _tag: 'Failure', failure: { _tag: 'IdentityConflictError' } })
      expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
    }))

  it('records the actor from the principal, never the operation', () =>
    withJournal(function* (journal) {
      const result = yield* journal.append(todos, add(1), {
        actorId: 'alice',
        canWrite: true,
      })
      expect(appendCommitted(result).actorId).toBe('alice')
    }))

  it('rejects invalid input before committing', () =>
    withJournal(function* (journal) {
      const result = yield* Effect.result(
        journal.append(todos, { opId: 'a:1', kind: 'nope', id: 'a' }, principal),
      )
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidOperationError' } })
      expect((yield* journal.load(todos)).cursor).toBe(0)
    }))

  it('refuses through validate without committing', () =>
    withJournal(
      function* (journal) {
        yield* journal.append(todos, add(1), principal)
        const result = yield* Effect.result(journal.append(todos, add(2), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'InvalidOperationError' },
        })
        expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['1'] }, cursor: 1 })
      },
      {
        validate: ({ cursor }) => {
          if (cursor > 0) throw new Error('must be empty')
        },
      },
    ))

  it('refuses through authorize and consumes no operation identity', () =>
    withJournal(
      function* (journal) {
        yield* journal.append(todos, add(1, 'a'), principal)
        const result = yield* Effect.result(journal.append(todos, remove(2, 'a'), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'OperationRejectedError' },
        })
        expect((yield* journal.load(todos)).cursor).toBe(1)

        yield* journal.append(todos, add(2, 'b'), principal)
        expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a', 'b'] }, cursor: 2 })
      },
      { authorize: ({ operation }) => operation.kind === 'add' },
    ))

  it('maps a throwing authorization policy to a typed refusal', () =>
    withJournal(
      function* (journal) {
        const result = yield* Effect.result(journal.append(todos, add(1, 'a'), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'InvalidOperationError' },
        })
        expect((yield* journal.load(todos)).cursor).toBe(0)
      },
      {
        authorize: () => {
          throw new Error('policy exploded')
        },
      },
    ))

  it('maps a throwing reducer to a typed failure without committing', () =>
    withJournal(
      function* (journal) {
        const result = yield* Effect.result(journal.append(todos, add(1, 'a'), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'InvalidOperationError' },
        })
        expect((yield* journal.load(todos)).cursor).toBe(0)
      },
      {
        reduce: () => {
          throw new Error('reduce exploded')
        },
      },
    ))

  it('compacts payloads while keeping identity and the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1, 'a'), principal)
      yield* journal.append(todos, add(2, 'b'), principal)
      yield* journal.append(todos, add(3, 'c'), principal)
      const before = yield* journal.load(todos)
      expect(yield* journal.floor(todos)).toBe(0)

      yield* journal.compact(todos, sequence(2))
      expect(yield* journal.floor(todos)).toBe(2)
      // `read` fails closed below the floor instead of returning a late tail.
      expect(yield* Effect.result(journal.read(todos, cursor(0)))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'CompactedCursorError', after: 0, floor: 2, cursor: 3 },
      })
      expect(yield* Effect.result(journal.read(todos, cursor(1)))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'CompactedCursorError' },
      })
      expect(
        (yield* journal.read(todos, cursor(2))).map(committed => committed.operation.opId),
      ).toEqual(['a:3'])
      expect(yield* journal.read(todos, cursor(3))).toEqual([])
      expect(yield* journal.load(todos)).toEqual(before)

      // A retransmission of a compacted operation is answered from its identity,
      // but the compacted payload is not returned.
      expect(yield* journal.append(todos, add(1, 'a'), principal)).toMatchObject({
        _tag: 'AlreadyCommitted',
        opId: 'a:1',
        sequence: 1,
      })
      expect(yield* journal.load(todos)).toEqual(before)
    }))

  it('refuses a compacted identity reused with different data or actor', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1, 'a'), principal)
      yield* journal.compact(todos, sequence(1))

      // Same opId, different payload: before the payload hash this was accepted
      // as an idempotent repeat and returned the uncommitted payload.
      const payload = yield* Effect.result(journal.append(todos, remove(1, 'a'), principal))
      expect(payload).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'IdentityConflictError' },
      })

      const actor = yield* Effect.result(
        journal.append(todos, add(1, 'a'), { actorId: 'mallory', canWrite: true }),
      )
      expect(actor).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'IdentityConflictError' },
      })
      expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
    }))

  it('refuses a compaction cursor that moves backwards or past the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1), principal)
      const past = yield* Effect.result(journal.compact(todos, sequence(2)))
      expect(past).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidCompactionError' } })
      yield* journal.compact(todos, sequence(1))
      const backwards = yield* Effect.result(journal.compact(todos, sequence(0)))
      expect(backwards).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidCompactionError' },
      })
    }))

  it('refuses a read cursor past the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1), principal)
      const result = yield* Effect.result(journal.read(todos, cursor(2)))
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidCursorError' } })
    }))

  it('upgrades a database written before version tracking, keeping its data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-migrate-'))
    const path = join(directory, 'journal.sqlite')
    try {
      // A database from before the `user_version` migration: the tables exist
      // and hold data, but no version is recorded.
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE documents (
          key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          compact_before INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE operations (
          key TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          actor_id TEXT NOT NULL, input TEXT,
          PRIMARY KEY (key, op_id), UNIQUE (key, sequence)
        );
        CREATE TABLE effects (
          key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, error TEXT
        );
        INSERT INTO operations (key, op_id, sequence, actor_id, input)
          VALUES ('todos', 'a:1', 1, 'owner', '{"opId":"a:1","kind":"add","id":"a"}');
        INSERT INTO documents (key, cursor, snapshot)
          VALUES ('todos', 1, '{"ids":["a"]}');
      `)
      legacy.close()

      await withJournal(
        function* (journal) {
          expect(
            (yield* journal.read(todos, cursor(0))).map(committed => [
              committed.operation.opId,
              committed.sequence,
            ]),
          ).toEqual([['a:1', 1]])
          expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
          // The log continues from the legacy cursor rather than restarting.
          expect(
            appendCommitted(yield* journal.append(todos, add(2, 'b'), principal)).sequence,
          ).toBe(2)
        },
        {},
        path,
      )

      const migrated = new DatabaseSync(path)
      try {
        expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
        // The payload identity is recomputed canonically, so a later retransmission
        // with a different key order still proves its payload.
        expect(
          migrated.prepare('SELECT payload_hash FROM operations WHERE op_id = ?').get('a:1'),
        ).toMatchObject({
          payload_hash: createHash('sha256')
            .update('{"id":"a","kind":"add","opId":"a:1"}')
            .digest('hex'),
        })
      } finally {
        migrated.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('completes a migration that did not finish, without losing existing data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-resume-'))
    const path = join(directory, 'journal.sqlite')
    try {
      // What a non-transactional migration would leave: version 0, the
      // documents table, and no operations or effects tables.
      const partial = new DatabaseSync(path)
      partial.exec(`
        CREATE TABLE documents (
          key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          compact_before INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO documents (key, cursor, snapshot) VALUES ('todos', 0, '{"ids":[]}');
      `)
      partial.close()

      await withJournal(
        function* (journal) {
          expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: [] }, cursor: 0 })
          yield* journal.append(todos, add(1, 'a'), principal)
          expect(yield* journal.load(todos)).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
        },
        {},
        path,
      )

      const migrated = new DatabaseSync(path)
      try {
        expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
      } finally {
        migrated.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses a database written by a newer schema version without touching it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-newer-'))
    const path = join(directory, 'journal.sqlite')
    try {
      const newer = new DatabaseSync(path)
      newer.exec(`
        CREATE TABLE documents (
          key TEXT PRIMARY KEY, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          compact_before INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE operations (
          key TEXT NOT NULL, op_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          actor_id TEXT NOT NULL, input TEXT, payload_hash TEXT,
          PRIMARY KEY (key, op_id), UNIQUE (key, sequence)
        );
        CREATE TABLE effects (
          key TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, error TEXT
        );
        PRAGMA user_version = 4;
      `)
      newer.close()

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.result(makeJournal<Operation, Snapshot, Principal>({ file: path, ...base })),
        ),
      )
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'UnsupportedJournalVersionError', found: 4, supported: 3 },
      })

      const after = new DatabaseSync(path)
      try {
        expect(after.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
      } finally {
        after.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('notifies subscribers after a commit and stops after unsubscribe', () =>
    withJournal(function* (journal) {
      const seen: string[] = []
      const subscriber = yield* Effect.forkScoped(
        Stream.runForEach(journal.subscribe, key => Effect.sync(() => seen.push(key))),
      )
      yield* Effect.yieldNow

      yield* journal.append(todos, add(1), principal)
      yield* Effect.yieldNow
      expect(seen).toEqual(['todos'])

      yield* Fiber.interrupt(subscriber)
      yield* journal.append(todos, add(2), principal)
      yield* Effect.yieldNow
      expect(seen).toEqual(['todos'])
    }))

  it('keeps committing when a subscriber throws', () =>
    withJournal(function* (journal) {
      const seen: string[] = []
      yield* Effect.forkScoped(
        Stream.runForEach(journal.subscribe, () =>
          Effect.sync(() => {
            throw new Error('subscriber failed')
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
      )
      yield* Effect.forkScoped(
        Stream.runForEach(journal.subscribe, key => Effect.sync(() => seen.push(key))),
      )
      yield* Effect.yieldNow

      yield* journal.append(todos, add(1), principal)
      yield* Effect.yieldNow
      // A failing subscriber is isolated: the commit lands and every other
      // subscriber still sees it.
      expect(seen).toEqual(['todos'])
      expect((yield* journal.load(todos)).cursor).toBe(1)
    }))
})

describe('the journal surface', () => {
  it('reports the committed opId', () =>
    withJournal(function* (journal) {
      const committed = appendCommitted(yield* journal.append(todos, add(1, 'a'), principal))
      expect(committed.opId).toBe('a:1')
      expect((yield* journal.read(todos, cursor(0)))[0]?.opId).toBe('a:1')
    }))

  it('appends a batch in order in one transaction', () =>
    withJournal(function* (journal) {
      const results = yield* journal.appendAll(todos, [add(1, 'a'), add(2, 'b')], principal)
      expect(results.map(result => result._tag)).toEqual(['Committed', 'Committed'])
      expect((yield* journal.read(todos, cursor(0))).map(row => row.sequence)).toEqual([1, 2])
      expect((yield* journal.load(todos)).snapshot).toEqual({ ids: ['a', 'b'] })
    }))

  it('rolls back the whole batch when one operation is refused', () =>
    withJournal(
      function* (journal) {
        const result = yield* Effect.result(
          journal.appendAll(todos, [add(1, 'a'), add(2, 'b'), add(3, 'c')], principal),
        )
        expect(result._tag).toBe('Failure')
        expect((yield* journal.load(todos)).cursor).toBe(0)
        expect(yield* journal.read(todos, cursor(0))).toEqual([])
      },
      {
        validate: ({ operation }) => {
          if (operation.id === 'b') throw new Error('refused')
        },
      },
    ))

  it('treats a reordered but logically equal payload as the same operation', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* makeJournal<Record<string, unknown>, Snapshot, Principal>({
            file: ':memory:',
            operation: {
              encode: value => value,
              decode: value => value as Record<string, unknown>,
            },
            snapshot,
            empty: () => ({ ids: [] }),
            reduce: (state, op) => ({ ids: [...state.ids, String(op.id)] }),
            opId: op => opId(String(op.opId)),
            actorId: (value: Principal) => actorId(value.actorId),
          })
          yield* journal.append(todos, { opId: 'a:1', id: 'a' }, principal)
          const again = yield* journal.append(todos, { id: 'a', opId: 'a:1' }, principal)
          if (again._tag !== 'Committed') throw new Error('Expected a committed operation')
          expect(again.committed.sequence).toBe(1)
          expect((yield* journal.load(todos)).snapshot).toEqual({ ids: ['a'] })
        }),
      ),
    ))

  it('lists document keys and resets one without touching the others', () =>
    withJournal(function* (journal) {
      yield* journal.append(todos, add(1, 'a'), principal)
      yield* journal.append(docA, add(1, 'b'), principal)

      expect(yield* journal.keys()).toEqual(['a', 'todos'])
      yield* journal.reset(docA)
      expect(yield* journal.keys()).toEqual(['todos'])
      expect(yield* journal.load(docA)).toEqual({ snapshot: { ids: [] }, cursor: 0 })
      expect((yield* journal.load(todos)).cursor).toBe(1)
    }))

  it('lists unfinished effects and clears one', () =>
    withJournal(function* (journal) {
      yield* Effect.result(journal.runEffect('k', Effect.fail(new Error('down'))))
      yield* journal.runEffect('ok', Effect.succeed('done'))

      expect((yield* journal.unfinished()).map(record => record.key)).toEqual(['k'])
      yield* journal.clearEffect('k')
      expect(yield* journal.unfinished()).toEqual([])
      expect(Option.isNone(yield* journal.effect('k'))).toBe(true)
    }))

  it('supports an Effect-returning authorization policy', () =>
    withJournal(
      function* (journal) {
        expect((yield* Effect.result(journal.append(todos, add(1, 'a'), principal)))._tag).toBe(
          'Failure',
        )
      },
      { authorize: () => Effect.succeed(false) },
    ))

  it('allows when the Effect authorization policy allows', () =>
    withJournal(
      function* (journal) {
        const committed = appendCommitted(yield* journal.append(todos, add(1, 'a'), principal))
        expect(committed.sequence).toBe(1)
      },
      { authorize: () => Effect.succeed(true) },
    ))

  it('does not retry a failed effect when asked', () =>
    withJournal(function* (journal) {
      let runs = 0
      const failing = Effect.gen(function* () {
        runs += 1
        return yield* Effect.fail(new Error('down'))
      })
      yield* Effect.result(journal.runEffect('k', failing))

      const blocked = yield* Effect.result(
        journal.runEffect('k', Effect.succeed('retry'), { retryFailed: false }),
      )
      expect(blocked._tag).toBe('Failure')
      if (blocked._tag === 'Failure') {
        expect(blocked.failure).toMatchObject({ _tag: 'EffectFailedError' })
      }
      expect(runs).toBe(1)

      // The default still retries a pending/failed record.
      expect(yield* journal.runEffect('k', Effect.succeed('retry'))).toBe('retry')
      expect(runs).toBe(1)
    }))
})

describe('the effect ledger', () => {
  it('runs an effect once per key and returns the recorded result', () =>
    withJournal(function* (journal) {
      let runs = 0
      const first = yield* journal.runEffect(
        'a:1/command/0',
        Effect.sync(() => {
          runs += 1
          return { sent: true }
        }),
      )
      expect(first).toEqual({ sent: true })

      const second = yield* journal.runEffect(
        'a:1/command/0',
        Effect.sync(() => {
          runs += 1
          return { sent: false }
        }),
      )
      expect(second).toEqual({ sent: true })
      expect(runs).toBe(1)
      expect(Option.getOrElse(yield* journal.effect('a:1/command/0'), () => undefined)).toEqual({
        key: 'a:1/command/0',
        status: 'succeeded',
        result: { sent: true },
      })
    }))

  it('shares one run between concurrent calls', () =>
    withJournal(function* (journal) {
      let runs = 0
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const run = (value: number) =>
        journal.runEffect(
          'k',
          Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return value
          }),
        )

      const first = yield* Effect.forkScoped(run(1))
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(run(2))
      // Let the second call reach the ledger while the first is still running,
      // so this asserts sharing rather than the recorded-result short-circuit.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(runs).toBe(1)

      yield* Deferred.succeed(release, undefined)
      const [a, b] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(runs).toBe(1)
      expect([a, b]).toEqual([1, 1])
    }))

  it('records a failure and allows a retry', () =>
    withJournal(function* (journal) {
      const failed = yield* Effect.result(
        journal.runEffect('k', Effect.fail(new Error('service down'))),
      )
      expect(failed._tag).toBe('Failure')
      expect(Option.getOrElse(yield* journal.effect('k'), () => undefined)).toMatchObject({
        status: 'failed',
        error: 'service down',
      })

      expect(yield* journal.runEffect('k', Effect.succeed('recovered'))).toBe('recovered')
      expect(Option.getOrElse(yield* journal.effect('k'), () => undefined)).toMatchObject({
        status: 'succeeded',
        result: 'recovered',
      })
    }))

  it('shares one failure between concurrent calls', () =>
    withJournal(function* (journal) {
      let runs = 0
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const run = () =>
        journal.runEffect(
          'k',
          Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return yield* Effect.fail(new Error('down'))
          }),
        )

      const first = yield* Effect.forkScoped(run())
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(run())
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(runs).toBe(1)

      yield* Deferred.succeed(release, undefined)
      const [a, b] = yield* Effect.all([
        Effect.result(Fiber.join(first)),
        Effect.result(Fiber.join(second)),
      ])
      expect(runs).toBe(1)
      expect([a._tag, b._tag]).toEqual(['Failure', 'Failure'])
      expect(Option.getOrElse(yield* journal.effect('k'), () => undefined)).toMatchObject({
        status: 'failed',
        error: 'down',
      })
    }))

  it('reports no record for an unrun key and keeps keys independent', () =>
    withJournal(function* (journal) {
      expect(Option.isNone(yield* journal.effect('missing'))).toBe(true)
      yield* journal.runEffect('a', Effect.succeed('a'))
      yield* journal.runEffect('b', Effect.succeed('b'))
      expect(Option.getOrElse(yield* journal.effect('a'), () => undefined)).toMatchObject({
        result: 'a',
      })
      expect(Option.getOrElse(yield* journal.effect('b'), () => undefined)).toMatchObject({
        result: 'b',
      })
    }))

  it('keeps a recorded effect across a reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foldkit-effects-'))
    const path = join(directory, 'journal.sqlite')
    let runs = 0
    try {
      await withJournal(
        function* (journal) {
          yield* journal.runEffect(
            'k',
            Effect.sync(() => {
              runs += 1
              return 'recorded'
            }),
          )
        },
        {},
        path,
      )
      await withJournal(
        function* (journal) {
          const result = yield* journal.runEffect(
            'k',
            Effect.sync(() => {
              runs += 1
              return 'again'
            }),
          )
          expect(result).toBe('recorded')
          expect(runs).toBe(1)
        },
        {},
        path,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('counts a coalesced run once', () =>
    withJournal(function* (journal) {
      const runsBefore = yield* Metric.value(journalMetrics.effectRuns)
      const coalescedBefore = yield* Metric.value(journalMetrics.effectRunsCoalesced)
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let executions = 0
      const run = () =>
        journal.runEffect(
          'shared',
          Effect.gen(function* () {
            executions += 1
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return 'done'
          }),
        )

      const first = yield* Effect.forkScoped(run())
      yield* Deferred.await(started)
      const second = yield* Effect.forkScoped(run())
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])

      expect(executions).toBe(1)
      // The owner run is counted once and the joined call as coalesced, never
      // as a second execution.
      expect((yield* Metric.value(journalMetrics.effectRuns)).count - runsBefore.count).toBe(1)
      expect(
        (yield* Metric.value(journalMetrics.effectRunsCoalesced)).count - coalescedBefore.count,
      ).toBe(1)
    }))
})

describe('the journal layer', () => {
  it('provides the journal as a scoped service with a Config file', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* JournalService<Operation, Snapshot, Principal>()
        yield* journal.append(todos, add(1, 'a'), principal)
        return yield* journal.load(todos)
      }).pipe(
        Effect.provide(
          makeJournalLayer<Operation, Snapshot, Principal>({
            file: Config.succeed(':memory:'),
            ...base,
          }),
        ),
      ),
    )

    expect(result).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
  })
})
