import { Effect, Schema } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { Entity, REMOTE_PROTOCOL_VERSION, RemoteRpc } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { RemoteServer } from '../src/index.js'

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
  RemoteServer.entity<string>(entity as never, {
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
