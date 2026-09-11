import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, Mutation, RemoteRpc } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer } from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, admin: Schema.Boolean }),
)

const RenameUser = Mutation.make('RenameUser', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

interface Request {
  readonly entity: string
  readonly id: string
  readonly fields: ReadonlyArray<string>
}

const server = RemoteServer.make(
  {},
  {
    entities: [
      RemoteServer.entity<string>(User, {
        authorize: (principal, fields) =>
          principal === 'admin' ? fields : fields.filter(field => field !== 'admin'),
        read: ({ ids, fields }) =>
          Effect.succeed(
            ids.map(id => ({
              id,
              values: Object.fromEntries(
                fields
                  .filter(field => field !== 'missing')
                  .map(field => [field, field === 'admin' ? true : `${field}:${id}`]),
              ),
            })),
          ),
      }),
    ],
    mutations: [
      RemoteServer.mutation(RenameUser, ({ input }) =>
        Effect.succeed({
          output: { id: input.id },
          entities: [Entity.patch(User.ref(input.id), { name: input.name })],
        }),
      ),
    ],
  },
)

const layer = (principal: string) =>
  RemoteRpc.toLayer({
    ...RemoteServer.handlers(server, principal),
    FoldkitRemoteLive: () => Stream.empty,
  })

const read = (principal: string, requests: ReadonlyArray<Request>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteRead({ requests })
      }),
    ).pipe(Effect.provide(layer(principal))),
  )

const mutate = (mutation: string, input: unknown) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteMutate({ requestId: 'r1', mutation, input })
      }),
    ).pipe(Effect.provide(layer('user'))),
  )

describe('RemoteServer', () => {
  it('enforces field-level selection authorization', async () => {
    const requests: ReadonlyArray<Request> = [
      { entity: 'User', id: 'u1', fields: ['id', 'name', 'admin'] },
    ]

    const asUser = await read('user', requests)
    expect(asUser.entities).toEqual([
      { entity: 'User', id: 'u1', values: { id: 'id:u1', name: 'name:u1' } },
    ])

    const asAdmin = await read('admin', requests)
    expect(asAdmin.entities).toEqual([
      { entity: 'User', id: 'u1', values: { id: 'id:u1', name: 'name:u1', admin: true } },
    ])
  })

  it('reflects a partial entity in the returned values (presence)', async () => {
    const result = await read('user', [{ entity: 'User', id: 'u1', fields: ['id', 'missing'] }])
    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { id: 'id:u1' } }])
  })

  it('returns nothing for an entity the principal may not see', async () => {
    const result = await read('nobody', [{ entity: 'User', id: 'u1', fields: ['admin'] }])
    expect(result.entities).toEqual([])
  })

  it('runs a mutation and returns typed Output plus normalized patches', async () => {
    const result = await mutate('RenameUser', { id: 'u1', name: 'ada' })
    expect(result.output).toEqual({ id: 'u1' })
    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { name: 'ada' } }])
  })

  it('rejects an unknown mutation', async () => {
    await expect(mutate('Nope', {})).rejects.toThrow()
  })

  it('rejects invalid mutation input at the schema boundary', async () => {
    await expect(mutate('RenameUser', { id: 'u1' })).rejects.toThrow()
  })
})
