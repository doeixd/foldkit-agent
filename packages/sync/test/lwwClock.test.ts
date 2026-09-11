import { readFileSync } from 'node:fs'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  documentId,
  openLwwClock,
  replicaId,
  StorageError,
  type LwwClockState,
  type Storage,
} from '../src/index.js'

const initial: LwwClockState = {
  schemaVersion: 1,
  documentId: documentId('todos'),
  replicaId: replicaId('a'),
  revision: 0,
}
const memory = (saved: unknown = undefined) => {
  let state = saved
  let closes = 0
  const storage: Storage = {
    load: () => Effect.sync(() => structuredClone(state)),
    save: (next, expectedRevision) =>
      Effect.gen(function* () {
        const revision = (state as LwwClockState | undefined)?.revision ?? null
        if (revision !== expectedRevision)
          return yield* new StorageError({ message: 'Stale writer' })
        state = structuredClone(next)
      }),
    close: Effect.sync(() => {
      closes++
    }),
  }
  return { storage, closes: () => closes }
}
const open = (storage: Storage) =>
  openLwwClock({ documentId: documentId('todos'), replicaId: replicaId('a'), storage })

describe('a durable LWW clock', () => {
  it('persists before issuing a stamp and serializes overlapping allocations', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const entered = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const clock = yield* open({
            ...saved.storage,
            save: (next, revision) =>
              Effect.gen(function* () {
                if ((next as LwwClockState).revision === 1) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(blocked)
                }
                yield* saved.storage.save(next, revision)
              }),
          })
          const issued: number[] = []
          const first = yield* Effect.forkScoped(
            clock.next().pipe(Effect.tap(stamp => Effect.sync(() => issued.push(stamp.counter)))),
          )
          const second = yield* Effect.forkScoped(
            clock.next(7).pipe(Effect.tap(stamp => Effect.sync(() => issued.push(stamp.counter)))),
          )
          yield* Deferred.await(entered)
          expect(issued).toEqual([])
          expect(yield* saved.storage.load()).toEqual(initial)
          yield* Deferred.succeed(blocked, undefined)
          expect(yield* Effect.all([Fiber.join(first), Fiber.join(second)])).toEqual([
            { counter: 1, replicaId: 'a' },
            { counter: 8, replicaId: 'a' },
          ])
          expect(yield* saved.storage.load()).toEqual({ ...initial, revision: 8 })
          yield* clock.close
        }),
      ),
    ))

  it('retains issued and observed counters across reload even without a submitted operation', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory()
          const first = yield* open(saved.storage)
          expect(yield* first.next(40)).toEqual({ counter: 41, replicaId: 'a' })
          yield* first.close
          const second = yield* open(saved.storage)
          expect(yield* second.next(2)).toEqual({ counter: 42, replicaId: 'a' })
          yield* second.close
        }),
      ),
    ))

  it('rejects a stale writer without returning a duplicate stamp', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const first = yield* open(saved.storage)
          const second = yield* open(saved.storage)
          expect(yield* first.next()).toEqual({ counter: 1, replicaId: 'a' })
          expect(yield* Effect.result(second.next())).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Stale writer') },
          })
          yield* first.close
          yield* second.close
        }),
      ),
    ))

  it('does not issue a stamp on save failure and permits a later allocation', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          let fail = true
          const clock = yield* open({
            ...saved.storage,
            save: (next, revision) =>
              Effect.gen(function* () {
                if (fail) {
                  fail = false
                  return yield* new StorageError({ message: 'Disk full' })
                }
                yield* saved.storage.save(next, revision)
              }),
          })
          expect(yield* Effect.result(clock.next(10))).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Disk full') },
          })
          expect(yield* saved.storage.load()).toEqual(initial)
          expect(yield* clock.next()).toEqual({ counter: 1, replicaId: 'a' })
          yield* clock.close
        }),
      ),
    ))

  it('drains accepted work once on close and refuses allocations after close starts', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const entered = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const clock = yield* open({
            ...saved.storage,
            save: (next, revision) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(blocked)
                yield* saved.storage.save(next, revision)
              }),
          })
          const allocation = yield* Effect.forkScoped(clock.next())
          yield* Deferred.await(entered)
          const closing = yield* Effect.forkScoped(clock.close)
          // Let the close fiber set the closed flag before probing.
          yield* Effect.yieldNow
          expect(saved.closes()).toBe(0)
          expect(yield* Effect.result(clock.next())).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Clock is closed') },
          })
          yield* Deferred.succeed(blocked, undefined)
          expect(yield* Fiber.join(allocation)).toEqual({ counter: 1, replicaId: 'a' })
          yield* Fiber.join(closing)
          expect(saved.closes()).toBe(1)
        }),
      ),
    ))

  it('does not reuse a timestamp when a save commits but its acknowledgement fails', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const clock = yield* open({
            ...saved.storage,
            save: (next, revision) =>
              Effect.gen(function* () {
                yield* saved.storage.save(next, revision)
                return yield* new StorageError({ message: 'Lost acknowledgement' })
              }),
          })
          expect(yield* Effect.result(clock.next())).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Lost acknowledgement') },
          })
          expect(yield* Effect.result(clock.next())).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Stale writer') },
          })
          yield* clock.close
          const reopened = yield* open(saved.storage)
          expect(yield* reopened.next()).toEqual({ counter: 2, replicaId: 'a' })
          yield* reopened.close
        }),
      ),
    ))

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an invalid observed counter: %s', (_, counter) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const clock = yield* open(saved.storage)
          expect((yield* Effect.result(clock.next(counter)))._tag).toBe('Failure')
          expect(yield* saved.storage.load()).toEqual(initial)
          yield* clock.close
        }),
      ),
    ),
  )

  it('refuses counter exhaustion without corrupting the last valid state', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const clock = yield* open(saved.storage)
          const counter = Number.MAX_SAFE_INTEGER
          expect(yield* clock.next(counter - 1)).toEqual({ counter, replicaId: 'a' })
          expect((yield* Effect.result(clock.next()))._tag).toBe('Failure')
          expect(yield* saved.storage.load()).toEqual({ ...initial, revision: counter })
          yield* clock.close
        }),
      ),
    ))

  it.each([
    ['document', { ...initial, documentId: 'other' }],
    ['replica', { ...initial, replicaId: 'b' }],
    ['counter', { ...initial, revision: 0.5 }],
    ['extra field', { ...initial, extra: true }],
  ])('closes storage when saved state has invalid %s', (_, state) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(state)
          expect((yield* Effect.result(open(saved.storage)))._tag).toBe('Failure')
          expect(saved.closes()).toBe(1)
        }),
      ),
    ),
  )

  it('reports an unsupported newer schema version without overwriting the state', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = { ...initial, schemaVersion: 2 }
          const saved = memory(state)
          expect(yield* Effect.result(open(saved.storage))).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'UnsupportedClockVersionError', schemaVersion: 2 },
          })
          expect(yield* saved.storage.load()).toEqual(state)
          expect(saved.closes()).toBe(1)
        }),
      ),
    ))

  it('opens a checked-in clock state and continues above its high-water mark', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = JSON.parse(
            readFileSync(new URL('./fixtures/previousClockState.json', import.meta.url), 'utf8'),
          )
          const clock = yield* open(memory(state).storage)
          expect(yield* clock.next()).toEqual({ counter: 41, replicaId: 'a' })
          yield* clock.close
        }),
      ),
    ))

  it('closes storage when initialization cannot persist its identity', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory()
          const failed = yield* Effect.result(
            open({
              ...saved.storage,
              save: () => Effect.fail(new StorageError({ message: 'Disk full' })),
            }),
          )
          expect(failed._tag).toBe('Failure')
          expect(saved.closes()).toBe(1)
        }),
      ),
    ))

  it('refuses an allocation queued behind a close', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const saved = memory(initial)
          const entered = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const clock = yield* open({
            ...saved.storage,
            save: (next, revision) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(blocked)
                yield* saved.storage.save(next, revision)
              }),
          })
          const first = yield* Effect.forkScoped(clock.next())
          yield* Deferred.await(entered)
          // Passes the pre-lock check, then queues behind the first allocation.
          const queued = yield* Effect.forkScoped(clock.next())
          yield* Effect.yieldNow
          const closing = yield* Effect.forkScoped(clock.close)
          yield* Effect.yieldNow
          yield* Deferred.succeed(blocked, undefined)

          expect(yield* Fiber.join(first)).toEqual({ counter: 1, replicaId: 'a' })
          expect(yield* Effect.result(Fiber.join(queued))).toMatchObject({
            _tag: 'Failure',
            failure: { message: expect.stringContaining('Clock is closed') },
          })
          yield* Fiber.join(closing)
        }),
      ),
    ))
})
