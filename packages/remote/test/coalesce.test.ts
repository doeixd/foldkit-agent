import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROTOCOL_VERSION,
  Remote,
  RemoteClient,
  RemoteReadError,
  coalesceReads,
  requirementKey,
  type BatchRead,
} from '../src/index.js'

type Batch = Parameters<BatchRead>[0]

const answer = (batch: Batch) => ({
  entities: batch.requests.map(request => ({
    entity: request.entity,
    id: request.id,
    values: Object.fromEntries(request.fields.map(field => [field, `${field}:${request.id}`])),
  })),
})

/** A raw read that records every batch and can be held open per call. */
const recording = (options: { readonly hold?: boolean; readonly fail?: boolean } = {}) => {
  const batches: Batch[] = []
  const gates: Array<Deferred.Deferred<void>> = []
  const read: BatchRead = batch =>
    Effect.gen(function* () {
      batches.push(batch)
      if (options.hold === true) {
        const gate = yield* Deferred.make<void>()
        gates.push(gate)
        yield* Deferred.await(gate)
      }
      if (options.fail === true) return yield* new RemoteReadError({ message: 'boom' })
      return answer(batch)
    })
  return { batches, gates, read }
}

const req = (id: string, fields: string[]) => ({ entity: 'User', id, fields })
const batch = (...requests: Array<ReturnType<typeof req>>): Batch => ({
  version: REMOTE_PROTOCOL_VERSION,
  requests,
})

describe('coalesceReads', () => {
  it('runs concurrent identical reads once and fans the result out', async () => {
    const raw = recording()
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        return yield* Effect.all(
          [read(batch(req('u1', ['name']))), read(batch(req('u1', ['name'])))],
          { concurrency: 'unbounded' },
        )
      }),
    )
    expect(raw.batches).toHaveLength(1)
    expect(results[0]).toEqual(results[1])
    expect(results[0].entities).toEqual([{ entity: 'User', id: 'u1', values: { name: 'name:u1' } }])
  })

  it('unions overlapping fields and batches different ids into one read', async () => {
    const raw = recording()
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        yield* Effect.all(
          [
            read(batch(req('u1', ['name']))),
            read(batch(req('u1', ['email']))),
            read(batch(req('u2', ['name']))),
          ],
          { concurrency: 'unbounded' },
        )
      }),
    )
    expect(raw.batches).toHaveLength(1)
    expect(raw.batches[0]!.requests).toEqual([req('u1', ['name', 'email']), req('u2', ['name'])])
  })

  it('each waiter sees the whole batch, so it can write every entity it needs', async () => {
    const raw = recording()
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        return yield* Effect.all(
          [read(batch(req('u1', ['name']))), read(batch(req('u2', ['name'])))],
          { concurrency: 'unbounded' },
        )
      }),
    )
    expect(results[0].entities.map(entity => entity.id)).toEqual(['u1', 'u2'])
  })

  it('joins a requirement already in flight instead of reading it again', async () => {
    const raw = recording({ hold: true })
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        const first = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(raw.batches).toHaveLength(1)
        const second = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Deferred.succeed(raw.gates[0]!, undefined)
        return [yield* Fiber.join(first), yield* Fiber.join(second)]
      }),
    )
    expect(raw.batches).toHaveLength(1)
    expect(first).toEqual(second)
  })

  it('a later batch reads only what is not in flight', async () => {
    const raw = recording({ hold: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        const first = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const second = yield* Effect.forkChild(
          read(batch(req('u1', ['name']), req('u2', ['name']))),
        )
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(raw.batches).toHaveLength(2)
        expect(raw.batches[1]!.requests).toEqual([req('u2', ['name'])])
        for (const gate of raw.gates) yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        const joined = yield* Fiber.join(second)
        expect(joined.entities.map(entity => entity.id).sort()).toEqual(['u1', 'u2'])
      }),
    )
  })

  it('a failed read fails every waiter and releases the requirement', async () => {
    const raw = recording({ fail: true })
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        const failures = yield* Effect.all(
          [
            Effect.result(read(batch(req('u1', ['name'])))),
            Effect.result(read(batch(req('u1', ['name'])))),
          ],
          { concurrency: 'unbounded' },
        )
        const again = yield* Effect.result(read(batch(req('u1', ['name']))))
        return { failures, again }
      }),
    )
    expect(outcome.failures.map(result => result._tag)).toEqual(['Failure', 'Failure'])
    expect(outcome.again._tag).toBe('Failure')
    expect(raw.batches).toHaveLength(2)
  })

  it('interrupting the only waiter keeps the batch running for a later joiner', async () => {
    const raw = recording({ hold: true })
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        const fiber = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        yield* Effect.yieldNow
        const later = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(raw.batches).toHaveLength(1)
        yield* Deferred.succeed(raw.gates[0]!, undefined)
        const exit = yield* Fiber.await(later)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    )
  })

  it('an empty batch never touches the transport', async () => {
    const raw = recording()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read)
        return yield* read(batch())
      }),
    )
    expect(result).toEqual({ entities: [] })
    expect(raw.batches).toHaveLength(0)
  })

  it('a window collects requirements issued apart in time', async () => {
    const raw = recording()
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* coalesceReads(raw.read, { window: '50 millis' })
        const first = yield* Effect.forkChild(read(batch(req('u1', ['name']))))
        yield* TestClock.adjust('10 millis')
        const second = yield* Effect.forkChild(read(batch(req('u2', ['name']))))
        yield* TestClock.adjust('100 millis')
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(raw.batches).toHaveLength(1)
    expect(raw.batches[0]!.requests.map(request => request.id)).toEqual(['u1', 'u2'])
  })

  it('keys a requirement by its content, not its field order', () => {
    expect(requirementKey(req('u1', ['a', 'b']))).toBe(requirementKey(req('u1', ['b', 'a'])))
    expect(requirementKey(req('u1', ['a']))).not.toBe(requirementKey(req('u2', ['a'])))
    expect(
      requirementKey({ ...req('u1', ['a']), relations: { a: { entity: 'B', fields: ['x'] } } }),
    ).not.toBe(requirementKey(req('u1', ['a'])))
  })
})

describe('Remote.coalesced and Remote.clientLayer', () => {
  it('wraps a hand-written client so its reads coalesce', async () => {
    const raw = recording()
    const Raw = Layer.succeed(RemoteClient, {
      read: raw.read,
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.empty,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        yield* Effect.all(
          [client.read(batch(req('u1', ['name']))), client.read(batch(req('u1', ['name'])))],
          { concurrency: 'unbounded' },
        )
      }).pipe(Effect.provide(Remote.coalesced(Raw))),
    )
    expect(raw.batches).toHaveLength(1)
  })

  it('clientLayer coalesces the RPC client’s reads', async () => {
    const raw = recording()
    const rpc = {
      FoldkitRemoteRead: raw.read,
      FoldkitRemoteQuery: () => Effect.die('unused'),
      FoldkitRemoteMutate: () => Effect.die('unused'),
      FoldkitRemoteLive: () => Stream.empty,
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        yield* Effect.all(
          [client.read(batch(req('u1', ['name']))), client.read(batch(req('u2', ['name'])))],
          { concurrency: 'unbounded' },
        )
      }).pipe(Effect.provide(Remote.clientLayer(rpc as never))),
    )
    expect(raw.batches).toHaveLength(1)
    expect(Schema.is(Schema.Number)(raw.batches[0]!.version)).toBe(true)
  })
})
