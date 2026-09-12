import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, REMOTE_PROTOCOL_VERSION, RemoteRpc, type ReadRequest } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer, type HandlerOptions } from '../src/index.js'

const User = Entity.make(
  'User',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    manager: Entity.refTo('User'),
  }),
)
const Comment = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, body: Schema.String, author: Entity.ref(User) }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    owner: Entity.ref(User),
    comments: Schema.Array(Entity.ref(Comment)),
    parent: Entity.refTo('Project'),
  }),
)

type Request = Schema.Schema.Type<typeof ReadRequest>

const reads: Array<{ entity: string; ids: ReadonlyArray<string>; fields: ReadonlyArray<string> }> =
  []

const rows: Record<string, Record<string, unknown>> = {
  'Project:p1': {
    name: 'Apollo',
    owner: 'User:u1',
    comments: ['Comment:c1', 'Comment:c2'],
    parent: 'Project:p0',
  },
  'Project:p0': { name: 'Root', owner: 'User:u1', comments: [], parent: 'Project:p1' },
  'User:u1': { name: 'ada', email: 'ada@x', manager: 'User:u2' },
  'User:u2': { name: 'grace', email: 'grace@x', manager: 'User:u3' },
  'User:u3': { name: 'linus', email: 'linus@x', manager: 'User:u3' },
  'Comment:c1': { body: 'one', author: 'User:u1' },
  'Comment:c2': { body: 'two', author: 'User:u2' },
}

const tableSource = <Name extends string>(
  entity: { readonly name: Name },
  authorize?: (principal: string, fields: readonly string[]) => readonly string[],
) =>
  RemoteServer.entity<string>(entity as never, {
    ...(authorize === undefined ? {} : { authorize }),
    read: ({ ids, fields }) =>
      Effect.sync(() => {
        reads.push({ entity: entity.name, ids, fields })
        return ids.flatMap(id => {
          const row = rows[`${entity.name}:${id}`]
          return row === undefined
            ? []
            : [{ id, values: Object.fromEntries(fields.map(field => [field, row[field]])) }]
        })
      }),
  })

const server = RemoteServer.make({
  entities: [
    tableSource(Project),
    tableSource(Comment),
    tableSource(User, (principal, fields) =>
      principal === 'admin' ? fields : fields.filter(field => field !== 'email'),
    ),
  ],
})

const read = (principal: string, requests: ReadonlyArray<Request>, options?: HandlerOptions) => {
  reads.length = 0
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(RemoteRpc)
        return yield* client.FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
      }),
    ).pipe(
      Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(server, principal, options) })),
    ),
  )
}

const card: Request = {
  entity: 'Project',
  id: 'p1',
  fields: ['name', 'owner', 'comments'],
  relations: {
    owner: { entity: 'User', fields: ['name'] },
    comments: {
      entity: 'Comment',
      fields: ['body', 'author'],
      relations: { author: { entity: 'User', fields: ['name'] } },
    },
  },
}

describe('RemoteServer nested resolution', () => {
  it('resolves the whole graph in one read, one source read per level and entity', async () => {
    const result = await read('admin', [card])
    expect(result.entities).toEqual([
      {
        entity: 'Project',
        id: 'p1',
        values: { name: 'Apollo', owner: 'User:u1', comments: ['Comment:c1', 'Comment:c2'] },
      },
      { entity: 'User', id: 'u1', values: { name: 'ada' } },
      { entity: 'Comment', id: 'c1', values: { body: 'one', author: 'User:u1' } },
      { entity: 'Comment', id: 'c2', values: { body: 'two', author: 'User:u2' } },
      { entity: 'User', id: 'u2', values: { name: 'grace' } },
    ])
    // u1 is the owner and c1's author; the batch read it once.
    expect(reads).toEqual([
      { entity: 'Project', ids: ['p1'], fields: ['name', 'owner', 'comments'] },
      { entity: 'User', ids: ['u1'], fields: ['name'] },
      { entity: 'Comment', ids: ['c1', 'c2'], fields: ['body', 'author'] },
      { entity: 'User', ids: ['u2'], fields: ['name'] },
    ])
  })

  it('asks a shared target only for the fields the batch has not read', async () => {
    const result = await read('admin', [
      {
        ...card,
        relations: {
          ...card.relations,
          comments: {
            entity: 'Comment',
            fields: ['author'],
            relations: { author: { entity: 'User', fields: ['name', 'email'] } },
          },
        },
      },
    ])
    // Level 3 needs u1's email (its name came at level 1) and all of u2.
    expect(reads.at(-1)).toEqual({ entity: 'User', ids: ['u1', 'u2'], fields: ['email', 'name'] })
    expect(result.entities.filter(entity => entity.id === 'u2')).toHaveLength(1)
  })

  it('authorizes every level through the target entity source', async () => {
    const withEmail = {
      ...card,
      relations: { ...card.relations, owner: { entity: 'User', fields: ['name', 'email'] } },
    }
    expect(
      (await read('admin', [withEmail])).entities.find(entity => entity.id === 'u1')?.values,
    ).toEqual({ name: 'ada', email: 'ada@x' })
    expect(
      (await read('member', [withEmail])).entities.find(entity => entity.id === 'u1')?.values,
    ).toEqual({ name: 'ada' })
  })

  it('does not follow a relation whose field the principal may not read', async () => {
    const locked = RemoteServer.make({
      entities: [
        tableSource(Project, (_principal, fields) => fields.filter(field => field !== 'owner')),
        tableSource(User),
      ],
    })
    reads.length = 0
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({
            version: REMOTE_PROTOCOL_VERSION,
            requests: [
              {
                entity: 'Project',
                id: 'p1',
                fields: ['name', 'owner'],
                relations: { owner: { entity: 'User', fields: ['name'] } },
              },
            ],
          })
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(locked, 'x') }))),
    )
    expect(result.entities.map(entity => entity.entity)).toEqual(['Project'])
    expect(reads.map(entry => entry.entity)).toEqual(['Project'])
  })

  it('ignores a ref whose entity is not the declared target', async () => {
    const result = await read('admin', [
      {
        entity: 'Project',
        id: 'p1',
        fields: ['owner'],
        relations: { owner: { entity: 'Comment', fields: ['body'] } },
      },
    ])
    expect(result.entities.map(entity => entity.entity)).toEqual(['Project'])
  })

  it('a cyclic selection terminates at the selection’s own depth', async () => {
    const result = await read('admin', [
      {
        entity: 'Project',
        id: 'p1',
        fields: ['parent'],
        relations: {
          parent: {
            entity: 'Project',
            fields: ['parent'],
            relations: { parent: { entity: 'Project', fields: ['name'] } },
          },
        },
      },
    ])
    expect(result.entities.map(entity => `${entity.id}:${Object.keys(entity.values)}`)).toEqual([
      'p1:parent',
      'p0:parent',
      'p1:name',
    ])
  })

  it('refuses a selection deeper than maxDepth', async () => {
    // p1 → u1 → u2 → u3: three relation levels, each a target not yet read.
    const deep: Request = {
      entity: 'Project',
      id: 'p1',
      fields: ['owner'],
      relations: {
        owner: {
          entity: 'User',
          fields: ['manager'],
          relations: {
            manager: {
              entity: 'User',
              fields: ['manager'],
              relations: { manager: { entity: 'User', fields: ['name'] } },
            },
          },
        },
      },
    }
    await expect(read('admin', [deep], { maxDepth: 2 })).rejects.toThrow(
      /deeper than 2 relation levels/,
    )
    const resolved = await read('admin', [deep], { maxDepth: 3 })
    expect(resolved.entities.map(entity => entity.id)).toEqual(['p1', 'u1', 'u2', 'u3'])
  })
})

describe('RemoteServer protocol version', () => {
  const call = (version: number) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* Effect.result(
            client.FoldkitRemoteRead({
              version,
              requests: [{ entity: 'Project', id: 'p1', fields: ['name'] }],
            }),
          )
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(server, 'admin') }))),
    )

  it('refuses a read from another version with a typed error and reads nothing', async () => {
    reads.length = 0
    const result = await call(REMOTE_PROTOCOL_VERSION + 1)
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure).toMatchObject({
      _tag: 'RemoteProtocolError',
      expected: REMOTE_PROTOCOL_VERSION,
      received: REMOTE_PROTOCOL_VERSION + 1,
    })
    expect(reads).toEqual([])
  })

  it('serves the current version', async () => {
    expect((await call(REMOTE_PROTOCOL_VERSION))._tag).toBe('Success')
  })

  it('refuses a live subscription from another version', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* Effect.result(
            client
              .FoldkitRemoteLive({ version: 1, requirements: [], after: 0 })
              .pipe(Stream.runCollect),
          )
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(server, 'admin') }))),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure).toMatchObject({ _tag: 'RemoteProtocolError', received: 1 })
  })
})
