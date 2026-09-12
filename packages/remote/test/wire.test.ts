import { Effect, Schema, Stream } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import {
  MAX_FIELDS_PER_REQUEST,
  MAX_RELATION_DEPTH,
  REMOTE_PROTOCOL_VERSION,
  ReadBatch,
  ReadBatchResult,
  ReadRequest,
  RemoteRpc,
} from '../src/index.js'

/** A request whose relations nest `depth` levels below the root. */
const nested = (depth: number): Record<string, unknown> => {
  const relation = (remaining: number): Record<string, unknown> =>
    remaining === 0
      ? { entity: 'User', fields: ['id'] }
      : { entity: 'User', fields: ['id'], relations: { manager: relation(remaining - 1) } }
  return depth === 0
    ? { entity: 'User', id: 'u1', fields: ['id'] }
    : { entity: 'User', id: 'u1', fields: ['id'], relations: { manager: relation(depth - 1) } }
}

describe('Remote wire', () => {
  it('round-trips the read batch schemas', () => {
    const batch = {
      version: REMOTE_PROTOCOL_VERSION,
      requests: [{ entity: 'User', id: 'u1', fields: ['id', 'name'] }],
    }
    expect(Schema.decodeUnknownSync(ReadBatch)(batch)).toEqual(batch)
    expect(Schema.encodeSync(ReadBatch)(batch)).toEqual(batch)

    const result = { entities: [{ entity: 'User', id: 'u1', values: { name: 'ada' } }] }
    expect(Schema.decodeUnknownSync(ReadBatchResult)(result)).toEqual(result)
  })

  it('refuses a request nesting relations deeper than MAX_RELATION_DEPTH', () => {
    const decode = Schema.decodeUnknownSync(ReadRequest)
    expect(decode(nested(MAX_RELATION_DEPTH))).toEqual(nested(MAX_RELATION_DEPTH))
    expect(() => decode(nested(MAX_RELATION_DEPTH + 1))).toThrow()
  })

  it('refuses a request naming more fields than MAX_FIELDS_PER_REQUEST', () => {
    const decode = Schema.decodeUnknownSync(ReadRequest)
    const fields = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`)
    const atCap = { entity: 'User', id: 'u1', fields: fields(MAX_FIELDS_PER_REQUEST) }
    expect(decode(atCap)).toEqual(atCap)
    expect(() => decode({ ...atCap, fields: fields(MAX_FIELDS_PER_REQUEST + 1) })).toThrow()
    expect(() =>
      decode({
        ...nested(1),
        relations: { manager: { entity: 'User', fields: fields(MAX_FIELDS_PER_REQUEST + 1) } },
      }),
    ).toThrow()
  })

  it('round-trips a relation window on a read request', () => {
    const batch = {
      version: REMOTE_PROTOCOL_VERSION,
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
        version: REMOTE_PROTOCOL_VERSION,
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
