import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import { Remote, RemoteClient, type RemoteRpcClient } from '../src/index.js'

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

describe('Remote.clientLayer', () => {
  it('adapts the RPC client and reconstructs a LiveEvent from the wire change', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RemoteClient
        const read = yield* client.read({
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
