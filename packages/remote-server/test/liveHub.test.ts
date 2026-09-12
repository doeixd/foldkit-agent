import { Effect, Fiber, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, REMOTE_PROTOCOL_VERSION, RemoteRpc, type ReadRequest } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer, RemoteServerError, type LiveHub } from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
)

const rows: Record<string, Record<string, unknown>> = {
  u1: { name: 'ada', email: 'ada@x' },
  u2: { name: 'grace', email: 'grace@x' },
}
const reads: Array<{
  ids: ReadonlyArray<string>
  fields: ReadonlyArray<string>
  principal: string
}> = []

const server = RemoteServer.make({
  entities: [
    RemoteServer.entity<string>(User, {
      authorize: (principal, fields) =>
        principal === 'admin' ? fields : fields.filter(field => field !== 'email'),
      read: ({ ids, fields, principal }) =>
        Effect.sync(() => {
          reads.push({ ids, fields, principal })
          return ids.flatMap(id => {
            const row = rows[id]
            return row === undefined
              ? []
              : [{ id, values: Object.fromEntries(fields.map(field => [field, row[field]])) }]
          })
        }),
    }),
  ],
})

type Request = Schema.Schema.Type<typeof ReadRequest>

/** Subscribes through the RPC handlers and collects `count` events, then leaves. */
const subscribe = (
  hub: LiveHub<string>,
  principal: string,
  requirements: ReadonlyArray<Request>,
  after: number,
  count: number,
) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(RemoteRpc)
    return yield* client
      .FoldkitRemoteLive({ version: REMOTE_PROTOCOL_VERSION, requirements, after })
      .pipe(Stream.take(count), Stream.runCollect)
  }).pipe(
    Effect.scoped,
    Effect.provide(RemoteRpc.toLayer(RemoteServer.handlers(server, principal, { live: hub }))),
  )

const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) yield* Effect.yieldNow
})

describe('RemoteServer.liveHub', () => {
  it('re-reads the changed fields a subscriber selects and streams them from its cursor', async () => {
    reads.length = 0
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const fiber = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name'] }], 4, 1),
        )
        yield* settle
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['name', 'email'])
        return [...(yield* Fiber.join(fiber))]
      }),
    )
    expect(events).toEqual([
      {
        _tag: 'EntityPatched',
        cursor: 5,
        entity: 'User',
        id: 'u1',
        values: { name: 'ada' },
        changed: ['name'],
      },
    ])
    expect(reads).toEqual([{ ids: ['u1'], fields: ['name'], principal: 'admin' }])
  })

  it('does no source work for a subscriber that selects none of the changed fields', async () => {
    reads.length = 0
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const fiber = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name'] }], 0, 1),
        )
        yield* settle
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['email'])
        yield* hub.changed({ entity: 'User', id: 'u2' }, ['name'])
        expect(reads).toEqual([])
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['name'])
        return [...(yield* Fiber.join(fiber))]
      }),
    )
    expect(events.map(event => event._tag)).toEqual(['EntityPatched'])
    expect(reads).toHaveLength(1)
  })

  it('authorizes the re-read under each subscriber’s principal', async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const member = yield* Effect.forkChild(
          subscribe(hub, 'member', [{ entity: 'User', id: 'u1', fields: ['name', 'email'] }], 0, 1),
        )
        const admin = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name', 'email'] }], 0, 1),
        )
        yield* settle
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['email', 'name'])
        return { member: [...(yield* Fiber.join(member))], admin: [...(yield* Fiber.join(admin))] }
      }),
    )
    expect(events.member[0]).toMatchObject({ values: { name: 'ada' }, changed: ['name'] })
    expect(events.admin[0]).toMatchObject({
      values: { email: 'ada@x', name: 'ada' },
      changed: ['email', 'name'],
    })
  })

  it('a change of only forbidden fields reaches nobody', async () => {
    reads.length = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const fiber = yield* Effect.forkChild(
          subscribe(hub, 'member', [{ entity: 'User', id: 'u1', fields: ['email'] }], 0, 1),
        )
        yield* settle
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['email'])
        yield* settle
        expect(reads).toEqual([])
        yield* Fiber.interrupt(fiber)
      }),
    )
  })

  it('subscribers sharing a principal share one source read', async () => {
    reads.length = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const a = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name'] }], 0, 1),
        )
        const b = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['email'] }], 0, 1),
        )
        yield* settle
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['name', 'email'])
        const [first, second] = [[...(yield* Fiber.join(a))][0], [...(yield* Fiber.join(b))][0]]
        expect(first).toMatchObject({ values: { name: 'ada' } })
        expect(second).toMatchObject({ values: { email: 'ada@x' } })
      }),
    )
    expect(reads).toEqual([{ ids: ['u1'], fields: ['name', 'email'], principal: 'admin' }])
  })

  it('deleted reaches every subscriber of the entity, with the next cursor', async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const fiber = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name'] }], 9, 2),
        )
        yield* settle
        // u2's deletion is not this subscriber's; it must not consume a cursor.
        yield* hub.deleted({ entity: 'User', id: 'u2' })
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['name'])
        yield* hub.deleted({ entity: 'User', id: 'u1' })
        return [...(yield* Fiber.join(fiber))]
      }),
    )
    expect(events.map(event => [event._tag, event.cursor])).toEqual([
      ['EntityPatched', 10],
      ['EntityDeleted', 11],
    ])
  })

  it('a subscriber leaves the hub when its stream ends', async () => {
    const sizes = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(server)
        const fiber = yield* Effect.forkChild(
          subscribe(hub, 'admin', [{ entity: 'User', id: 'u1', fields: ['name'] }], 0, 1),
        )
        yield* settle
        const during = yield* hub.size
        yield* hub.changed({ entity: 'User', id: 'u1' }, ['name'])
        yield* Fiber.join(fiber)
        yield* settle
        return { during, after: yield* hub.size }
      }),
    )
    expect(sizes).toEqual({ during: 1, after: 0 })
  })

  it('a source failure surfaces to the caller of changed', async () => {
    const failing = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: () => Effect.fail(new RemoteServerError({ message: 'db down' })),
        }),
      ],
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hub = yield* RemoteServer.liveHub(failing)
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* RpcTest.makeClient(RemoteRpc)
              return yield* client
                .FoldkitRemoteLive({
                  version: REMOTE_PROTOCOL_VERSION,
                  requirements: [{ entity: 'User', id: 'u1', fields: ['name'] }],
                  after: 0,
                })
                .pipe(Stream.take(1), Stream.runCollect)
            }),
          ).pipe(
            Effect.provide(
              RemoteRpc.toLayer(RemoteServer.handlers(failing, 'admin', { live: hub })),
            ),
          ),
        )
        yield* settle
        const outcome = yield* Effect.result(hub.changed({ entity: 'User', id: 'u1' }, ['name']))
        yield* Fiber.interrupt(fiber)
        return outcome
      }),
    )
    expect(result._tag).toBe('Failure')
  })
})
