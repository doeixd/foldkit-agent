import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import { ReadBatch, ReadBatchResult, RemoteRpc } from '../src/index.js'

describe('Remote wire', () => {
  it('round-trips the read batch schemas', () => {
    const batch = { requests: [{ entity: 'User', id: 'u1', fields: ['id', 'name'] }] }
    expect(Schema.decodeUnknownSync(ReadBatch)(batch)).toEqual(batch)
    expect(Schema.encodeSync(ReadBatch)(batch)).toEqual(batch)

    const result = { entities: [{ entity: 'User', id: 'u1', values: { name: 'ada' } }] }
    expect(Schema.decodeUnknownSync(ReadBatchResult)(result)).toEqual(result)
  })

  it('round-trips a relation window on a read request', () => {
    const batch = {
      requests: [
        {
          entity: 'Project',
          id: 'p1',
          fields: ['id', 'comments'],
          windows: { comments: { first: 10 } },
        },
      ],
    }

    expect(Schema.decodeUnknownSync(ReadBatch)(batch)).toEqual(batch)
    expect(Schema.encodeSync(ReadBatch)(batch)).toEqual(batch)
  })

  it('serves reads and mutations over the in-process RPC layer, in order', async () => {
    const order: string[] = []

    const handlers = RemoteRpc.toLayer({
      FoldkitRemoteRead: payload =>
        Effect.succeed({
          entities: payload.requests.map(request => ({
            entity: request.entity,
            id: request.id,
            values: { name: 'ada' },
          })),
        }),
      FoldkitRemoteMutate: payload =>
        Effect.sync(() => {
          order.push(payload.requestId)
          return { output: { ok: true }, entities: [] }
        }),
      FoldkitRemoteQuery: () =>
        Effect.succeed({ edges: [], start: { _tag: 'Terminal' }, end: { _tag: 'Terminal' } }),
      FoldkitRemoteLive: () => Stream.empty,
    })

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(RemoteRpc)
      const read = yield* client.FoldkitRemoteRead({
        requests: [
          { entity: 'User', id: 'u1', fields: ['id', 'name'] },
          { entity: 'User', id: 'u1', fields: ['name'] },
        ],
      })
      yield* client.FoldkitRemoteMutate({
        requestId: 'r1',
        mutation: 'RenameUser',
        input: { name: 'ada' },
      })
      yield* client.FoldkitRemoteMutate({
        requestId: 'r2',
        mutation: 'RenameUser',
        input: { name: 'grace' },
      })
      return read
    })

    const read = await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(handlers)))

    expect(read.entities).toHaveLength(2)
    expect(order).toEqual(['r1', 'r2'])
  })
})
