import { Effect, Layer, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Mutation,
  RemoteClient,
  beginMutation,
  emptyMutationState,
  emptyStore,
  entityKey,
  failMutation,
  readField,
  reconcileMutation,
  writeEntity,
  type NormalizedPatch,
} from '../src/index.js'
import { mutate } from '../src/mutation.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const RenameUser = Mutation.make('RenameUser', {
  Input: Schema.Struct({ id: Schema.String, name: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})

const requests: Array<unknown> = []
const FakeClient = Layer.succeed(RemoteClient, {
  read: () => Effect.die('unused'),
  query: () => Effect.die('unused'),
  mutate: request =>
    Effect.sync(() => {
      requests.push(request)
      const input = request.input as { readonly id: string; readonly name: string }
      return {
        output: { id: input.id },
        entities: [{ entity: 'User', id: input.id, values: { name: input.name } }],
      }
    }),
})

describe('Remote mutations', () => {
  it('runs a mutation and decodes its typed Output', async () => {
    requests.length = 0
    const output = await Effect.runPromise(
      mutate(RenameUser, { id: 'u1', name: 'ada' }, 'req-1').pipe(Effect.provide(FakeClient)),
    )
    expect(output).toEqual({ id: 'u1' })
    expect(requests).toEqual([
      { requestId: 'req-1', mutation: 'RenameUser', input: { id: 'u1', name: 'ada' } },
    ])
  })

  it('reconciles a result at most once per requestId (retry-safe)', () => {
    const patches: NormalizedPatch[] = [{ entity: 'User', id: 'u1', values: { name: 'ada' } }]

    const first = reconcileMutation(emptyStore, emptyMutationState, 'req-1', patches)
    const second = reconcileMutation(first.store, first.state, 'req-1', patches)

    expect(second.store).toEqual(first.store)
    expect(second.state.applied.size).toBe(1)
    expect(readField(second.store, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))
  })

  it('a mutation result and a live write for the same entity agree', () => {
    const patches: NormalizedPatch[] = [{ entity: 'User', id: 'u1', values: { name: 'ada' } }]
    const byMutation = reconcileMutation(emptyStore, emptyMutationState, 'req-1', patches).store
    const byLive = writeEntity(emptyStore, entityKey('User', 'u1'), { name: 'ada' })
    expect(byMutation).toEqual(byLive)
  })

  it('tracks pending and failed status', () => {
    const pending = beginMutation(emptyMutationState, 'req-1')
    expect(pending.pending.has('req-1')).toBe(true)

    const failed = failMutation(pending, 'req-1')
    expect(failed.pending.has('req-1')).toBe(false)
    expect(failed.failed.has('req-1')).toBe(true)
  })
})
