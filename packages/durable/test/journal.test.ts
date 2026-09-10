import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect, Fiber, Option, type Scope } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeJournal, type Codec, type Journal, type JournalOptions } from '../src/index.js'

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

type Hooks = Pick<JournalOptions<Operation, Snapshot, Principal>, 'validate' | 'authorize'>

const base = {
  operation,
  snapshot,
  empty: (): Snapshot => ({ ids: [] }),
  reduce,
  opId: (value: Operation) => value.opId,
  actorId: (value: Principal) => value.actorId,
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

describe('a durable journal', () => {
  it('orders appends and reads them after a cursor', () =>
    withJournal(function* (journal) {
      yield* journal.append('todos', add(1, 'a'), principal)
      yield* journal.append('todos', add(2, 'b'), principal)

      const all = yield* journal.read('todos', 0)
      expect(all.map(committed => [committed.operation.opId, committed.sequence])).toEqual([
        ['a:1', 1],
        ['a:2', 2],
      ])
      const tail = yield* journal.read('todos', 1)
      expect(tail.map(committed => committed.operation.opId)).toEqual(['a:2'])
      expect(yield* journal.load('todos')).toEqual({
        snapshot: { ids: ['a', 'b'] },
        cursor: 2,
      })
    }))

  it('keeps keys independent', () =>
    withJournal(function* (journal) {
      yield* journal.append('a', add(1, 'a'), principal)
      yield* journal.append('b', add(1, 'b'), principal)

      expect((yield* journal.load('a')).snapshot).toEqual({ ids: ['a'] })
      expect((yield* journal.load('b')).snapshot).toEqual({ ids: ['b'] })
    }))

  it('treats an unknown key as empty and reads nothing at the cursor', () =>
    withJournal(function* (journal) {
      const first = yield* journal.load('missing')
      const second = yield* journal.load('missing')
      expect(first).toEqual({ snapshot: { ids: [] }, cursor: 0 })
      // `empty` runs per read, so callers cannot mutate a shared default.
      expect(first.snapshot).not.toBe(second.snapshot)

      yield* journal.append('todos', add(1, 'a'), principal)
      expect(yield* journal.read('todos', 1)).toEqual([])
    }))

  it('is idempotent by operation identity and rejects a conflicting reuse', () =>
    withJournal(function* (journal) {
      yield* journal.append('todos', add(1, 'a'), principal)
      const again = yield* journal.append('todos', add(1, 'a'), principal)
      expect(again.sequence).toBe(1)
      expect(yield* journal.load('todos')).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })

      const payload = yield* Effect.result(
        journal.append('todos', { ...add(1), id: 'different' }, principal),
      )
      expect(payload).toMatchObject({ _tag: 'Failure', failure: { _tag: 'IdentityConflictError' } })

      const actor = yield* Effect.result(
        journal.append('todos', add(1, 'a'), { actorId: 'other', canWrite: true }),
      )
      expect(actor).toMatchObject({ _tag: 'Failure', failure: { _tag: 'IdentityConflictError' } })
      expect(yield* journal.load('todos')).toEqual({ snapshot: { ids: ['a'] }, cursor: 1 })
    }))

  it('records the actor from the principal, never the operation', () =>
    withJournal(function* (journal) {
      const committed = yield* journal.append('todos', add(1), {
        actorId: 'alice',
        canWrite: true,
      })
      expect(committed.actorId).toBe('alice')
    }))

  it('rejects invalid input before committing', () =>
    withJournal(function* (journal) {
      const result = yield* Effect.result(
        journal.append('todos', { opId: 'a:1', kind: 'nope', id: 'a' }, principal),
      )
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidOperationError' } })
      expect((yield* journal.load('todos')).cursor).toBe(0)
    }))

  it('refuses through validate without committing', () =>
    withJournal(
      function* (journal) {
        yield* journal.append('todos', add(1), principal)
        const result = yield* Effect.result(journal.append('todos', add(2), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'InvalidOperationError' },
        })
        expect(yield* journal.load('todos')).toEqual({ snapshot: { ids: ['1'] }, cursor: 1 })
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
        yield* journal.append('todos', add(1, 'a'), principal)
        const result = yield* Effect.result(journal.append('todos', remove(2, 'a'), principal))
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'OperationRejectedError' },
        })
        expect((yield* journal.load('todos')).cursor).toBe(1)

        yield* journal.append('todos', add(2, 'b'), principal)
        expect(yield* journal.load('todos')).toEqual({ snapshot: { ids: ['a', 'b'] }, cursor: 2 })
      },
      { authorize: ({ operation }) => operation.kind === 'add' },
    ))

  it('compacts payloads while keeping identity and the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append('todos', add(1, 'a'), principal)
      yield* journal.append('todos', add(2, 'b'), principal)
      yield* journal.append('todos', add(3, 'c'), principal)
      const before = yield* journal.load('todos')
      expect(yield* journal.floor('todos')).toBe(0)

      yield* journal.compact('todos', 2)
      expect(yield* journal.floor('todos')).toBe(2)
      expect((yield* journal.read('todos', 0)).map(committed => committed.operation.opId)).toEqual([
        'a:3',
      ])
      expect(yield* journal.load('todos')).toEqual(before)

      // A retransmission of a compacted operation is still idempotent.
      expect((yield* journal.append('todos', add(1, 'a'), principal)).sequence).toBe(1)
      expect(yield* journal.load('todos')).toEqual(before)
    }))

  it('refuses a compaction cursor that moves backwards or past the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append('todos', add(1), principal)
      const past = yield* Effect.result(journal.compact('todos', 2))
      expect(past).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidCompactionError' } })
      yield* journal.compact('todos', 1)
      const backwards = yield* Effect.result(journal.compact('todos', 0))
      expect(backwards).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'InvalidCompactionError' },
      })
    }))

  it('refuses a read cursor past the snapshot', () =>
    withJournal(function* (journal) {
      yield* journal.append('todos', add(1), principal)
      const result = yield* Effect.result(journal.read('todos', 2))
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidCursorError' } })
    }))

  it('notifies subscribers after a commit and stops after unsubscribe', () =>
    withJournal(function* (journal) {
      const seen: string[] = []
      const unsubscribe = journal.subscribe(key => {
        seen.push(key)
      })

      yield* journal.append('todos', add(1), principal)
      expect(seen).toEqual(['todos'])

      unsubscribe()
      yield* journal.append('todos', add(2), principal)
      expect(seen).toEqual(['todos'])
    }))

  it('keeps committing when a subscriber throws', () =>
    withJournal(function* (journal) {
      journal.subscribe(() => {
        throw new Error('subscriber failed')
      })

      yield* journal.append('todos', add(1), principal)
      expect((yield* journal.load('todos')).cursor).toBe(1)
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
})
