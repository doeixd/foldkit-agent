import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  RemoteClient,
  Selection,
  emptyStore,
  entityKey,
  readField,
  writeEntity,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Data = Remote.make({ entities: [User] })
const Model = Schema.Struct({ remote: Data.Model, route: Schema.String })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.make({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const UserSummary = Selection.make(User, { id: true, name: true })
const NameOnly = Selection.make(User, { name: true })

const UserPage = Surface.define(App, 'UserPage', {
  Params: Schema.Struct({ userId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({ user: Remote.select(AppRemote, UserSummary)(params.userId) }),
  messages: [Message.Ping],
})

const NameCard = Surface.define(App, 'NameCard', {
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
})

const root = (store = emptyStore) => ({
  remote: { entities: store, connections: {}, requests: {}, mutations: {} },
  route: '/users/u1',
})

describe('Remote observation', () => {
  it('plans missing fields purely; render does no I/O', () => {
    calls.length = 0
    const model = root()
    const projection = Remote.select(AppRemote, UserSummary)('u1')

    expect(projection.read(model)).toEqual({ _tag: 'Initial' })
    expect(Remote.observeProjection(AppRemote, model, projection)).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])
    expect(calls).toHaveLength(0)
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

    expect(
      Remote.observeProjection(AppRemote, model, Remote.select(AppRemote, UserSummary)('u1')),
    ).toEqual([])
    await Effect.runPromise(
      Remote.prefetch(AppRemote, root(store), Remote.select(AppRemote, UserSummary)('u1')).pipe(
        Effect.provide(FakeClient),
      ),
    )
    expect(calls).toHaveLength(0)
  })

  it('derives requirements from the observed Surface', () => {
    const model = root()
    expect(Remote.planSurface(AppRemote, model, UserPage, { userId: 'u1' })).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])
    expect(Remote.planSurface(AppRemote, model, NameCard, { userId: 'u1' })).toEqual([
      { entity: 'User', id: 'u1', fields: ['name'] },
    ])
  })

  it('exposes a Foldkit Subscription entry that fetches the plan', async () => {
    calls.length = 0
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, result => result)
    const dependencies = entry.modelToDependencies(root())
    expect(dependencies.requirements).toEqual([
      { entity: 'User', id: 'u1', fields: ['id', 'name'] },
    ])

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(FakeClient)),
    )
    expect([...messages]).toEqual([
      { entities: [{ entity: 'User', id: 'u1', values: { id: 'u1', name: 'ada' } }] },
    ])
    expect(calls).toHaveLength(1)
  })

  it('emits no stream when the Surface is fully known', async () => {
    calls.length = 0
    const store = writeEntity(emptyStore, entityKey('User', 'u1'), { id: 'u1', name: 'ada' })
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, result => result)
    const dependencies = entry.modelToDependencies(root(store))
    expect(dependencies.requirements).toEqual([])

    const messages = await Effect.runPromise(
      Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(FakeClient)),
    )
    expect([...messages]).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
