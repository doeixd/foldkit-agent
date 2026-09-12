import { Effect, Schema } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, REMOTE_PROTOCOL_VERSION, RemoteRpc, type ReadRequest } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer, type HandlerOptions } from '../src/index.js'

type Request = Schema.Schema.Type<typeof ReadRequest>

const Team = Entity.make('Team', Schema.Struct({ id: Schema.String, name: Schema.String }))
const User = Entity.make(
  'User',
  Schema.Struct({ id: Schema.String, name: Schema.String, team: Entity.ref(Team) }),
)
const Comment = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, author: Entity.ref(User) }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, owner: Entity.ref(User), comment: Entity.ref(Comment) }),
)
const rows: Record<string, Record<string, unknown>> = {
  'Project:p1': { owner: 'User:u1', comment: 'Comment:c1' },
  'Comment:c1': { author: 'User:u1' },
  'User:u1': { name: 'ada', team: 'Team:t1' },
  'Team:t1': { name: 'core' },
}
const table = (entity: { readonly name: string }) =>
  RemoteServer.entity<string>(entity, {
    read: ({ ids, fields }) =>
      Effect.succeed(
        ids.flatMap(id => {
          const row = rows[`${entity.name}:${id}`]
          return row === undefined
            ? []
            : [{ id, values: Object.fromEntries(fields.map(field => [field, row[field]])) }]
        }),
      ),
  })
const server = RemoteServer.make({
  entities: [table(Project), table(Comment), table(User), table(Team)],
})

describe('a nested relation is followed even when its target was already fetched', () => {
  it('reads the team the comment author spec selects although the owner spec fetched the user a level earlier', async () => {
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
                fields: ['owner', 'comment'],
                relations: {
                  owner: { entity: 'User', fields: ['team'] },
                  comment: {
                    entity: 'Comment',
                    fields: ['author'],
                    relations: {
                      author: {
                        entity: 'User',
                        fields: ['team'],
                        relations: { team: { entity: 'Team', fields: ['name'] } },
                      },
                    },
                  },
                },
              },
            ],
          })
        }),
      ).pipe(Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(server, 'x') }))),
    )
    expect(result.entities.map(entity => `${entity.entity}:${entity.id}`)).toEqual([
      'Project:p1',
      'User:u1',
      'Comment:c1',
      'Team:t1',
    ])
  })
})

describe('review: grouping and levels', () => {
  const reads: Array<{ entity: string; ids: ReadonlyArray<string>; windows: unknown }> = []
  const recording = (entity: { readonly name: string }) =>
    RemoteServer.entity<string>(entity, {
      read: ({ ids, fields, windows }) =>
        Effect.sync(() => {
          reads.push({ entity: entity.name, ids, windows })
          return ids.flatMap(id => {
            const row = rows[`${entity.name}:${id}`]
            return row === undefined
              ? []
              : [{ id, values: Object.fromEntries(fields.map(field => [field, row[field]])) }]
          })
        }),
    })
  const recorded = RemoteServer.make({
    entities: [recording(Project), recording(Comment), recording(User), recording(Team)],
  })
  const read = (requests: ReadonlyArray<Request>, options: HandlerOptions<string> = {}) => {
    reads.length = 0
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(RemoteRpc)
          return yield* client.FoldkitRemoteRead({ version: REMOTE_PROTOCOL_VERSION, requests })
        }),
      ).pipe(
        Effect.provide(RemoteRpc.toLayer({ ...RemoteServer.handlers(recorded, 'x', options) })),
      ),
    )
  }

  it('reads ids that page a relation differently in separate groups, each with its own window', async () => {
    await read([
      { entity: 'Project', id: 'p1', fields: ['owner'], windows: { owner: { first: 1 } } },
      { entity: 'Project', id: 'p2', fields: ['owner'], windows: { owner: { first: 5 } } },
      { entity: 'Project', id: 'p3', fields: ['owner'], windows: { owner: { first: 1 } } },
    ])
    expect(reads.map(entry => [entry.ids, entry.windows])).toEqual([
      [['p1', 'p3'], { owner: { first: 1 } }],
      [['p2'], { owner: { first: 5 } }],
    ])
  })

  it('does not read a target twice when it is both a request and a same-level relation target', async () => {
    const result = await read([
      {
        entity: 'Comment',
        id: 'c1',
        fields: ['author'],
        relations: { author: { entity: 'User', fields: ['name'] } },
      },
      { entity: 'User', id: 'u1', fields: ['name'] },
    ])
    expect(reads.map(entry => [entry.entity, entry.ids])).toEqual([
      ['Comment', ['c1']],
      ['User', ['u1']],
    ])
    expect(result.entities.filter(entity => entity.entity === 'User')).toHaveLength(1)
  })

  it('a zero maxIdsPerEntity still reads a nested level', async () => {
    const result = await read(
      [
        {
          entity: 'Comment',
          id: 'c1',
          fields: ['author'],
          relations: { author: { entity: 'User', fields: ['name'] } },
        },
      ],
      { maxIdsPerEntity: 0 },
    )
    expect(result.entities.map(entity => entity.entity)).toEqual(['Comment', 'User'])
  })
})
