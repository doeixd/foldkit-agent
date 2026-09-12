import { Context, Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import {
  Entity,
  Mutation,
  Query,
  ReadBatch,
  REMOTE_PROTOCOL_VERSION,
  Remote,
  RemoteClient,
  RemoteRpc,
} from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer, RemoteServerError, type ServerDefinition } from '../src/index.js'

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

const server = RemoteServer.make({
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
        edges: [{ entity: 'Project', id: `p-${input.ownerId}`, key: `Project:p-${input.ownerId}` }],
        start: { _tag: 'Terminal' as const },
        end:
          window.first === undefined
            ? { _tag: 'Unknown' as const }
            : { _tag: 'Cursor' as const, cursor: 'c1' },
      }),
    ),
  ],
})

const layer = (principal: string) =>
  RemoteRpc.toLayer({
    ...RemoteServer.handlers(server, principal),
  })

const read = (principal: string, requests: ReadonlyArray<Request>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
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

  it('serves through Remote.clientLayer, the client adapter', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        return yield* client.read({
          version: REMOTE_PROTOCOL_VERSION,
          requests: [{ entity: 'User', id: 'u1', fields: ['id'] }],
        })
      }).pipe(Effect.provide(Remote.clientLayer(RemoteServer.handlers(server, 'admin')))),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { id: 'id:u1' } }])
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
    const permissive = RemoteServer.make({
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
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            version: REMOTE_PROTOCOL_VERSION,
            requests: [{ entity: 'User', id: 'u1', fields: ['id'] }],
          })
        }),
      ).pipe(
        Effect.provide(
          RemoteRpc.toLayer({
            ...RemoteServer.handlers(permissive, 'admin'),
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
    const failing = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: () => Effect.fail(new RemoteServerError({ message: 'source refused the read' })),
        }),
      ],
    })
    const failingLayer = RemoteRpc.toLayer({
      ...RemoteServer.handlers(failing, 'user'),
    })
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RemoteRpc)
            return yield* client.FoldkitRemoteRead({
              version: REMOTE_PROTOCOL_VERSION,
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

  it('groups requests per entity, unions fields, and dedupes ids', async () => {
    const calls: Array<{ ids: readonly string[]; fields: readonly string[] }> = []
    const recording = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: ({ ids, fields }) => {
            calls.push({ ids, fields })
            return Effect.succeed(
              ids.map(id => ({
                id,
                values: Object.fromEntries(fields.map(field => [field, `${field}:${id}`])),
              })),
            )
          },
        }),
      ],
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            version: REMOTE_PROTOCOL_VERSION,
            requests: [
              { entity: 'User', id: 'u1', fields: ['id', 'name'] },
              { entity: 'User', id: 'u1', fields: ['name', 'admin'] },
              { entity: 'User', id: 'u2', fields: ['id'] },
            ],
          })
        }),
      ).pipe(
        Effect.provide(
          RemoteRpc.toLayer({
            ...RemoteServer.handlers(recording, 'admin'),
          }),
        ),
      ),
    )

    expect(calls).toEqual([{ ids: ['u1', 'u2'], fields: ['id', 'name', 'admin'] }])
    expect(result.entities).toEqual([
      { entity: 'User', id: 'u1', values: { id: 'id:u1', name: 'name:u1', admin: 'admin:u1' } },
      { entity: 'User', id: 'u2', values: { id: 'id:u2', name: 'name:u2', admin: 'admin:u2' } },
    ])
  })

  it('skips an unknown entity without failing the batch', async () => {
    const result = await read('user', [
      { entity: 'Ghost', id: 'g1', fields: ['x'] },
      { entity: 'User', id: 'u1', fields: ['id'] },
    ])
    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { id: 'id:u1' } }])
  })

  it('returns nothing for an empty request batch', async () => {
    expect((await read('user', [])).entities).toEqual([])
  })

  it('ignores inherited properties for a crafted field name', async () => {
    const crafted = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: ({ ids }) =>
            Effect.succeed(
              ids.map(id => ({
                id,
                values: Object.assign(Object.create({ toString: 'leaked' }), { id }),
              })),
            ),
        }),
      ],
    })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            version: REMOTE_PROTOCOL_VERSION,
            requests: [{ entity: 'User', id: 'u1', fields: ['id', 'toString'] }],
          })
        }),
      ).pipe(
        Effect.provide(
          RemoteRpc.toLayer({
            ...RemoteServer.handlers(crafted, 'admin'),
          }),
        ),
      ),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { id: 'u1' } }])
  })

  it('threads a source service requirement into the handlers', async () => {
    class Tick extends Context.Service<Tick, { readonly value: number }>()('test/Tick') {}

    const source = RemoteServer.entity<string, Tick>(User, {
      read: ({ ids, fields }) =>
        Effect.gen(function* () {
          const tick = yield* Tick
          return ids.map(id => ({
            id,
            values: Object.fromEntries(fields.map(field => [field, `${field}:${tick.value}`])),
          }))
        }),
    })
    const withTick = RemoteServer.make({ entities: [source] })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            version: REMOTE_PROTOCOL_VERSION,
            requests: [{ entity: 'User', id: 'u1', fields: ['name'] }],
          })
        }),
      ).pipe(
        Effect.provide(
          RemoteRpc.toLayer({
            ...RemoteServer.handlers(withTick, 'user'),
          }),
        ),
        Effect.provideService(Tick, { value: 7 }),
      ),
    )

    expect(result.entities).toEqual([{ entity: 'User', id: 'u1', values: { name: 'name:7' } }])
  })

  it('refuses a read batch that exceeds the per-entity id limit', async () => {
    const server = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: ({ ids, fields }) =>
            Effect.succeed(
              ids.map(id => ({
                id,
                values: Object.fromEntries(fields.map(field => [field, field])),
              })),
            ),
        }),
      ],
    })
    const limited = RemoteRpc.toLayer({
      ...RemoteServer.handlers(server, 'user', { maxIdsPerEntity: 2 }),
    })

    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(RemoteRpc)
            return yield* client.FoldkitRemoteRead({
              version: REMOTE_PROTOCOL_VERSION,
              requests: [
                { entity: 'User', id: 'a', fields: ['id'] },
                { entity: 'User', id: 'b', fields: ['id'] },
                { entity: 'User', id: 'c', fields: ['id'] },
              ],
            })
          }),
        ).pipe(Effect.provide(limited)),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure._tag).toBe('RemoteReadError')
  })

  const readWithWindows = async (requests: Schema.Schema.Type<typeof ReadBatch>['requests']) => {
    const seen: Array<unknown> = []
    const server = RemoteServer.make({
      entities: [
        RemoteServer.entity<string>(User, {
          read: ({ ids, fields, windows }) => {
            seen.push(windows)
            return Effect.succeed(
              ids.map(id => ({
                id,
                values: Object.fromEntries(fields.map(field => [field, `${field}:${id}`])),
              })),
            )
          },
        }),
      ],
    })
    const layer = RemoteRpc.toLayer({
      ...RemoteServer.handlers(server, 'user'),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
        }),
      ).pipe(Effect.provide(layer)),
    )

    return seen
  }

  it('passes a relation window to the source read', async () => {
    expect(
      await readWithWindows([
        { entity: 'User', id: 'u1', fields: ['id', 'posts'], windows: { posts: { first: 10 } } },
      ]),
    ).toEqual([{ posts: { first: 10 } }])
  })

  it('drops a window for a field that is not read', async () => {
    expect(
      await readWithWindows([
        { entity: 'User', id: 'u1', fields: ['id'], windows: { admin: { first: 5 } } },
      ]),
    ).toEqual([undefined])
  })

  const collectLive = (
    definition: ServerDefinition<string, never>,
    payload: { requirements: ReadonlyArray<Request>; after: number },
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client
            .FoldkitRemoteLive({ version: REMOTE_PROTOCOL_VERSION, ...payload })
            .pipe(Stream.runCollect)
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer(RemoteServer.handlers(definition, 'user')))),
    )

  it('streams live patches and threads the resume cursor', async () => {
    const liveServer = RemoteServer.make({
      entities: [RemoteServer.entity<string>(User, { read: () => Effect.succeed([]) })],
      live: [
        RemoteServer.live<string>(User, {
          subscribe: ({ after }) =>
            Stream.make({
              _tag: 'EntityPatched' as const,
              cursor: after + 1,
              entity: 'User',
              id: 'u1',
              values: { name: 'ada' },
              changed: ['name'],
            }),
        }),
      ],
    })

    const patches = await collectLive(liveServer, {
      requirements: [{ entity: 'User', id: 'u1', fields: ['name'] }],
      after: 4,
    })
    expect([...patches]).toEqual([
      {
        _tag: 'EntityPatched',
        cursor: 5,
        entity: 'User',
        id: 'u1',
        values: { name: 'ada' },
        changed: ['name'],
      },
    ])
  })

  it('streams a connection change for the live wire', async () => {
    const liveServer = RemoteServer.make({
      entities: [RemoteServer.entity<string>(User, { read: () => Effect.succeed([]) })],
      live: [
        RemoteServer.live<string>(User, {
          subscribe: () =>
            Stream.make({
              _tag: 'ConnectionInsert' as const,
              cursor: 1,
              connection: 'ProjectsByOwner(u1)',
              position: 'prepend' as const,
              edge: { entity: 'Project', id: 'p1', key: 'Project:p1' },
            }),
        }),
      ],
    })

    const changes = await collectLive(liveServer, {
      requirements: [{ entity: 'User', id: 'u1', fields: ['name'] }],
      after: 0,
    })
    expect([...changes]).toEqual([
      {
        _tag: 'ConnectionInsert',
        cursor: 1,
        connection: 'ProjectsByOwner(u1)',
        position: 'prepend',
        edge: { entity: 'Project', id: 'p1', key: 'Project:p1' },
      },
    ])
  })

  it('emits nothing for an entity with no live source', async () => {
    const noLive = RemoteServer.make({
      entities: [RemoteServer.entity<string>(User, { read: () => Effect.succeed([]) })],
    })
    const patches = await collectLive(noLive, {
      requirements: [{ entity: 'User', id: 'u1', fields: ['name'] }],
      after: 0,
    })
    expect([...patches]).toEqual([])
  })

  it('accepts a server whose sources the domain declares', () => {
    const domain = Remote.make({ entities: [User], mutations: [RenameUser] })
    const server = RemoteServer.make({
      entities: [RemoteServer.entity<string>(User, { read: () => Effect.succeed([]) })],
      mutations: [
        RemoteServer.mutation(RenameUser, () => Effect.succeed({ output: { id: 'u1' } })),
      ],
    })
    expect(() => RemoteServer.validate(domain, server)).not.toThrow()
  })

  it('refuses a source the domain never declared', () => {
    const Ghost = Entity.make('Ghost', Schema.Struct({ id: Schema.String }))
    const domain = Remote.make({ entities: [Ghost] })
    const server = RemoteServer.make({
      entities: [RemoteServer.entity<string>(User, { read: () => Effect.succeed([]) })],
    })
    expect(() => RemoteServer.validate(domain, server)).toThrow(/User.*not declared/)
  })
})

describe('RemoteServer mutation connection changes', () => {
  it('returns the connection changes a mutation source reports', async () => {
    const AddComment = Mutation.make('AddComment', {
      Input: Schema.Struct({ body: Schema.String }),
      Output: Schema.Struct({ id: Schema.String }),
    })
    const definition = RemoteServer.make({
      entities: [],
      mutations: [
        RemoteServer.mutation(AddComment, () =>
          Effect.succeed({
            output: { id: 'c9' },
            connections: [
              {
                _tag: 'Insert' as const,
                connection: 'Feed',
                position: 'prepend' as const,
                edge: { entity: 'Comment', id: 'c9', key: 'Comment:c9' },
              },
            ],
          }),
        ),
      ],
    })
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteMutate({
            requestId: 'r1',
            mutation: 'AddComment',
            input: { body: 'hi' },
          })
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer(RemoteServer.handlers(definition, 'user')))),
    )
    expect(result.connections).toEqual([
      {
        _tag: 'Insert',
        connection: 'Feed',
        position: 'prepend',
        edge: { entity: 'Comment', id: 'c9', key: 'Comment:c9' },
      },
    ])
    expect(result.entities).toEqual([])
  })
})
