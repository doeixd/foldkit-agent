import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, Mutation, Query, RemoteRpc } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer, RemoteServerError } from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, admin: Schema.Boolean }),
)

const RenameUser = Mutation.make('RenameUser', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

const ProjectsByOwner = Query.make('ProjectsByOwner', {
  Input: Schema.Struct({ ownerId: Schema.String }),
  Result: Query.connection({ name: 'Project' }),
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
    queries: [
      RemoteServer.query(ProjectsByOwner, ({ input, window }) =>
        Effect.succeed({
          edges: [
            { entity: 'Project', id: `p-${input.ownerId}`, key: `Project:p-${input.ownerId}` },
          ],
          start: { _tag: 'Terminal' as const },
          end:
            window.first === undefined
              ? { _tag: 'Unknown' as const }
              : { _tag: 'Cursor' as const, cursor: 'c1' },
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

const query = (
  name: string,
  input: unknown,
  window: { first?: number; last?: number; after?: string; before?: string },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteQuery({ query: name, input, window })
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

  it('never returns a field the client did not request, even if authorize is permissive', async () => {
    const permissive = RemoteServer.make(
      {},
      {
        entities: [
          RemoteServer.entity<string>(User, {
            authorize: () => ['id', 'name', 'admin'],
            read: ({ ids, fields }) =>
              Effect.succeed(
                ids.map(id => ({
                  id,
                  values: Object.fromEntries(
                    fields.map(field => [field, field === 'admin' ? true : `${field}:${id}`]),
                  ),
                })),
              ),
          }),
        ],
      },
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            requests: [{ entity: 'User', id: 'u1', fields: ['id'] }],
          })
        }),
      ).pipe(
        Effect.provide(
          RemoteRpc.toLayer({
            ...RemoteServer.handlers(permissive, 'admin'),
            FoldkitRemoteLive: () => Stream.empty,
          }),
        ),
      ),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { id: 'id:u1' } }])
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

  it('serves a query connection page with its boundaries', async () => {
    const result = await query('ProjectsByOwner', { ownerId: 'u1' }, { first: 25 })
    expect(result.edges).toEqual([{ entity: 'Project', id: 'p-u1', key: 'Project:p-u1' }])
    expect(result.start).toEqual({ _tag: 'Terminal' })
    expect(result.end).toEqual({ _tag: 'Cursor', cursor: 'c1' })

    const unknownEnd = await query('ProjectsByOwner', { ownerId: 'u1' }, {})
    expect(unknownEnd.end).toEqual({ _tag: 'Unknown' })
  })

  it('rejects an unknown query', async () => {
    await expect(query('Nope', {}, {})).rejects.toThrow()
  })

  it('remaps a source RemoteServerError onto the wire error', async () => {
    const failing = RemoteServer.make(
      {},
      {
        entities: [
          RemoteServer.entity<string>(User, {
            read: () => Effect.fail(new RemoteServerError({ message: 'source refused the read' })),
          }),
        ],
      },
    )
    const failingLayer = RemoteRpc.toLayer({
      ...RemoteServer.handlers(failing, 'user'),
      FoldkitRemoteLive: () => Stream.empty,
    })
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RemoteRpc)
            return yield* client.FoldkitRemoteRead({
              requests: [{ entity: 'User', id: 'u1', fields: ['id'] }],
            })
          }),
        ).pipe(Effect.provide(failingLayer)),
      ),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteReadError')
    expect(result.failure.message).toBe('source refused the read')
  })
})
