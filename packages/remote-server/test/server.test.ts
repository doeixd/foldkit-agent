import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, RemoteRpc } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer } from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, admin: Schema.Boolean }),
)

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
  },
)

const read = (principal: string, requests: ReadonlyArray<Request>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteRead({ requests })
      }),
    ).pipe(
      Effect.provide(
        RemoteRpc.toLayer({
          ...RemoteServer.handlers(server, principal),
          FoldkitRemoteMutate: () => Effect.succeed({ output: null, entities: [] }),
          FoldkitRemoteLive: () => Stream.empty,
        }),
      ),
    ),
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
})
