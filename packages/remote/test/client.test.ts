import { Context, Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Remote,
  RemoteClient,
  liveEventOf,
  type RemoteRpcClient,
  REMOTE_PROTOCOL_VERSION,
} from '../src/index.js'

const batch = {
  entities: [{ entity: 'User', id: 'u1', values: { name: 'ada' } }],
}

const FakeRpc: RemoteRpcClient = {
  FoldkitRemoteRead: () => Effect.succeed(batch),
  FoldkitRemoteQuery: () =>
    Effect.succeed({
      edges: [],
      start: { _tag: 'Terminal' } as const,
      end: { _tag: 'Terminal' } as const,
    }),
  FoldkitRemoteMutate: () => Effect.succeed({ output: { ok: true }, entities: [] }),
  FoldkitRemoteLive: () =>
    Stream.make({
      _tag: 'EntityPatched' as const,
      cursor: 1,
      entity: 'User',
      id: 'u1',
      values: { name: 'ada' },
      changed: ['name'],
    }),
}

class Database extends Context.Service<Database, { readonly rows: ReadonlyArray<string> }>()(
  'Database',
) {}

describe('Remote.clientLayer', () => {
  it('supplies what an in-process RPC client requires when the layer is built', async () => {
    const needsDatabase: RemoteRpcClient<Database> = {
      ...FakeRpc,
      FoldkitRemoteRead: () =>
        Effect.gen(function* () {
          const database = yield* Database
          return {
            entities: database.rows.map(id => ({ entity: 'User', id, values: { name: id } })),
          }
        }),
      FoldkitRemoteLive: () =>
        Stream.fromEffect(Database).pipe(
          Stream.map(database => ({
            _tag: 'EntityDeleted' as const,
            cursor: 1,
            entity: 'User',
            id: database.rows[0]!,
          })),
        ),
    }
    const layer = Remote.clientLayer(needsDatabase).pipe(
      Layer.provide(Layer.succeed(Database, { rows: ['u9'] })),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        const read = yield* client.read({
          version: REMOTE_PROTOCOL_VERSION,
          requests: [{ entity: 'User', id: 'u9', fields: ['name'] }],
        })
        const events = yield* client
          .live({ requirements: [{ entity: 'User', id: 'u9', fields: ['name'] }], after: 0 })
          .pipe(Stream.runCollect)
        return { read, events: [...events] }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.read.entities).toEqual([{ entity: 'User', id: 'u9', values: { name: 'u9' } }])
    expect(result.events).toEqual([
      { _tag: 'EntityDeleted', ref: { entity: 'User', id: 'u9' }, cursor: 1 },
    ])
  })

  it('adapts the RPC client and reconstructs a LiveEvent from the wire change', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        const read = yield* client.read({
          version: REMOTE_PROTOCOL_VERSION,
          requests: [{ entity: 'User', id: 'u1', fields: ['name'] }],
        })
        const events = yield* client
          .live({ requirements: [{ entity: 'User', id: 'u1', fields: ['name'] }], after: 0 })
          .pipe(Stream.runCollect)
        return { read, events: [...events] }
      }).pipe(Effect.provide(Remote.clientLayer(FakeRpc))),
    )

    expect(result.read.entities).toEqual(batch.entities)
    expect(result.events).toEqual([
      {
        _tag: 'EntityPatched',
        ref: { entity: 'User', id: 'u1' },
        values: { name: 'ada' },
        changed: ['name'],
        cursor: 1,
      },
    ])
  })
})

describe('liveEventOf', () => {
  it('reconstructs every wire variant as its LiveEvent', () => {
    expect(liveEventOf({ _tag: 'EntityDeleted', cursor: 2, entity: 'User', id: 'u1' })).toEqual({
      _tag: 'EntityDeleted',
      ref: { entity: 'User', id: 'u1' },
      cursor: 2,
    })

    expect(
      liveEventOf({
        _tag: 'ConnectionInsert',
        cursor: 3,
        connection: 'c1',
        position: 'prepend',
        edge: { entity: 'User', id: 'u1', key: 'k' },
      }),
    ).toEqual({
      _tag: 'ConnectionInsert',
      connection: 'c1',
      position: 'prepend',
      edge: { key: 'k', ref: { entity: 'User', id: 'u1' } },
      cursor: 3,
    })

    expect(
      liveEventOf({
        _tag: 'ConnectionRemove',
        cursor: 4,
        connection: 'c1',
        edge: { entity: 'User', id: 'u1', key: 'k' },
      }),
    ).toEqual({
      _tag: 'ConnectionRemove',
      connection: 'c1',
      edge: { key: 'k', ref: { entity: 'User', id: 'u1' } },
      cursor: 4,
    })

    expect(liveEventOf({ _tag: 'ConnectionInvalidate', cursor: 5, connection: 'c1' })).toEqual({
      _tag: 'ConnectionInvalidate',
      connection: 'c1',
      cursor: 5,
    })
  })
})
