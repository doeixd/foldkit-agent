import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Optimistic,
  Remote,
  RemoteClient,
  RemoteReadError,
  Selection,
  emptyOptimistic,
  emptyStore,
  entityKey,
  initialRemoteModel,
  readField,
  writeEntity,
  type RemoteMessage,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Data = Remote.make({ entities: [User] })
const Model = Schema.Struct({ remote: Data.Model, route: Schema.String })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const UserSummary = Selection.make(User, { id: true, name: true })
const NameOnly = Selection.make(User, { name: true })

const UserPage = Surface.make(App, 'UserPage', {
  Params: Schema.Struct({ userId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({ user: Remote.select(AppRemote, UserSummary)(params.userId) }),
  messages: [Message.Ping],
})

const NameCard = Surface.make(App, 'NameCard', {
  Params: Schema.Struct({ userId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({ name: Remote.select(AppRemote, NameOnly)(params.userId) }),
  messages: [Message.Ping],
})

const calls: Array<unknown> = []
const FakeClient = Layer.succeed(RemoteClient, {
  read: batch =>
    Effect.sync(() => {
      calls.push(batch)
      return {
        entities: batch.requests.map(request => ({
          entity: request.entity,
          id: request.id,
          values: { id: request.id, name: 'ada' },
        })),
      }
    }),
  query: () => Effect.die('unused'),
  mutate: () => Effect.die('unused'),
  live: () => Stream.empty,
})

const root = (store = emptyStore) => ({
  remote: { ...initialRemoteModel, entities: store },
  route: '/users/u1',
})

const ObserveMessage = defineMessageUnion({
  Batch: {
    entities: Schema.Array(
      Schema.Struct({
        entity: Schema.String,
        id: Schema.String,
        values: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  },
  ReadError: { message: Schema.String },
})
type ObserveMessageType = Schema.Schema.Type<typeof ObserveMessage>

const toMessage = (message: RemoteMessage): ObserveMessageType => {
  switch (message._tag) {
    case 'ReadReceived':
      return ObserveMessage.Batch({
        entities: message.result.entities as ReadonlyArray<{
          readonly entity: string
          readonly id: string
          readonly values: Record<string, unknown>
        }>,
      })
    case 'ReadFailed':
      return ObserveMessage.ReadError({ message: message.error.message })
    default:
      throw new Error(`unexpected remote message: ${message._tag}`)
  }
}

describe('Remote observation', () => {
  it('plans missing fields purely; render does no I/O', () => {
    calls.length = 0
    const model = root()
    const projection = Remote.select(AppRemote, UserSummary)('u1')

    expect(projection.read(model)).toEqual({ _tag: 'Initial' })
    expect(Remote.plan(AppRemote, model, projection)).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])
    expect(calls).toHaveLength(0)
  })

  it('shares one visible store across plans of the same model', () => {
    const start = {
      ...initialRemoteModel,
      entities: writeEntity(emptyStore, entityKey('User', 'u1'), { name: 'x' }, 0),
      optimistic: Optimistic.begin(initialRemoteModel.optimistic, 'm1', [
        { entity: 'User', id: 'u1', values: { name: 'ada' } },
      ]),
    }
    const model = { remote: start, route: '/users/u1' }
    const projection = Remote.select(AppRemote, NameOnly)('u1')

    expect(Remote.plan(AppRemote, model, projection)).toEqual([])
    expect(projection.read(model)).toEqual({ _tag: 'Ready', value: { name: 'ada' } })
    const store = Remote.storeOf(AppRemote, model)
    expect(store).toBe(Remote.storeOf(AppRemote, { ...model, remote: { ...start } }))
    const patched = {
      ...start,
      optimistic: Optimistic.begin(start.optimistic, 'm2', [
        { entity: 'User', id: 'u1', values: { name: 'bob' } },
      ]),
    }
    expect(Remote.storeOf(AppRemote, { ...model, remote: patched })).not.toBe(store)
    expect(Remote.storeOf(AppRemote, { ...model, remote: initialRemoteModel })).toBe(emptyStore)
    expect(
      Remote.storeOf(AppRemote, { ...model, remote: { ...start, optimistic: emptyOptimistic } }),
    ).toBe(start.entities)
  })

  it('prefetches through the client and populates the store', async () => {
    calls.length = 0
    const store = await Effect.runPromise(
      Remote.prefetch(AppRemote, root(), Remote.select(AppRemote, UserSummary)('u1')).pipe(
        Effect.provide(FakeClient),
      ),
    )
    expect(calls).toHaveLength(1)
    expect(readField(store, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))
  })

  it('does not refetch a fully-known projection', async () => {
    calls.length = 0
    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 'ada' })
    const model = root(store)

    expect(Remote.plan(AppRemote, model, Remote.select(AppRemote, UserSummary)('u1'))).toEqual([])
    await Effect.runPromise(
      Remote.prefetch(AppRemote, root(store), Remote.select(AppRemote, UserSummary)('u1')).pipe(
        Effect.provide(FakeClient),
      ),
    )
    expect(calls).toHaveLength(0)
  })

  it('derives requirements from the observed Surface', () => {
    const model = root()
    expect(Remote.plan(AppRemote, model, UserPage.projection({ userId: 'u1' }))).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])
    expect(Remote.plan(AppRemote, model, NameCard.projection({ userId: 'u1' }))).toEqual([
      { entity: 'User', id: 'u1', fields: ['name'] },
    ])
  })

  it('exposes a Foldkit Subscription entry that fetches the plan', async () => {
    calls.length = 0
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, toMessage)
    const dependencies = entry.modelToDependencies(root())
    expect(dependencies.requirements).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(FakeClient)),
    )
    expect([...messages]).toEqual([
      {
        _tag: 'Batch',
        entities: [{ entity: 'User', id: 'u1', values: { id: 'u1', name: 'ada' } }],
      },
    ])
    expect(calls).toHaveLength(1)
  })

  it('emits no stream when the Surface is fully known', async () => {
    calls.length = 0
    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 'ada' })
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, toMessage)
    const dependencies = entry.modelToDependencies(root(store))
    expect(dependencies.requirements).toEqual([])

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(FakeClient)),
    )
    expect([...messages]).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('emits onError instead of failing the stream', async () => {
    const failing = Layer.succeed(RemoteClient, {
      read: () => Effect.fail(new RemoteReadError({ message: 'boom' })),
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.empty,
    })
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, toMessage)

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(entry.modelToDependencies(root()))).pipe(
        Effect.provide(failing),
      ),
    )
    expect([...messages]).toEqual([{ _tag: 'ReadError', message: 'boom' }])
  })

  it('propagates a read failure from prefetch', async () => {
    const failing = Layer.succeed(RemoteClient, {
      read: () => Effect.fail(new RemoteReadError({ message: 'boom' })),
      query: () => Effect.die('unused'),
      mutate: () => Effect.die('unused'),
      live: () => Stream.empty,
    })

    const result = await Effect.runPromise(
      Effect.result(
        Remote.prefetch(AppRemote, root(), Remote.select(AppRemote, UserSummary)('u1')).pipe(
          Effect.provide(failing),
        ),
      ),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('RemoteReadError')
  })
})
