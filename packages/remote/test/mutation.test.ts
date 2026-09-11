import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Mutation,
  Remote,
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
  live: () => Stream.empty,
})

describe('Remote mutations', () => {
  it('runs a mutation and decodes its typed Output', async () => {
    requests.length = 0
    const output = await Effect.runPromise(
      Remote.mutate(RenameUser, { id: 'u1', name: 'ada' }, 'req-1').pipe(
        Effect.provide(FakeClient),
      ),
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

  it('bounds the settled-request ledger', () => {
    let state = emptyMutationState
    for (let index = 0; index < 4096; index += 1) {
      state = reconcileMutation(emptyStore, state, `req-${index}`, []).state
    }

    expect(state.applied.size).toBeLessThan(4096)
    expect(state.applied.has('req-0')).toBe(false)
    expect(state.applied.has('req-4095')).toBe(true)
  })

  it('bounds the failed-request ledger', () => {
    let state = emptyMutationState
    for (let index = 0; index < 4096; index += 1) {
      state = failMutation(state, `req-${index}`)
    }

    expect(state.failed.size).toBeLessThan(4096)
    expect(state.failed.has('req-4095')).toBe(true)
  })

  it('clears pending even when a request is re-begun and reconciled again', () => {
    const started = beginMutation(emptyMutationState, 'req-1')
    const first = reconcileMutation(emptyStore, started, 'req-1', [
      { entity: 'User', id: 'u1', values: { name: 'ada' } },
    ])
    expect(first.state.pending.has('req-1')).toBe(false)

    // A retry re-begins the same request; settling it must not leave it pending,
    // and must not re-apply the older entities.
    const retried = beginMutation(first.state, 'req-1')
    expect(retried.pending.has('req-1')).toBe(true)
    const second = reconcileMutation(first.store, retried, 'req-1', [
      { entity: 'User', id: 'u1', values: { name: 'grace' } },
    ])
    expect(second.state.pending.has('req-1')).toBe(false)
    expect(readField(second.store, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))
  })

  it('maps an input encode failure onto RemoteMutationError', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Remote.mutate(RenameUser, { id: 1 as unknown as string, name: 'ada' }, 'req-1').pipe(
          Effect.provide(FakeClient),
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteMutationError')
  })

  it('maps an output decode failure onto RemoteMutationError', async () => {
    const badOutput = Layer.succeed(RemoteClient, {
      read: () => Effect.die('unused'),
      query: () => Effect.die('unused'),
      mutate: () => Effect.succeed({ output: { id: 123 }, entities: [] }),
      live: () => Stream.empty,
    })

    const result = await Effect.runPromise(
      Effect.result(
        Remote.mutate(RenameUser, { id: 'u1', name: 'ada' }, 'req-1').pipe(
          Effect.provide(badOutput),
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteMutationError')
  })
})
