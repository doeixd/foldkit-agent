import { Effect, Layer, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  RemoteClient,
  RemotePolicy,
  Selection,
  emptyStore,
  entityKey,
  initialRemoteModel,
  isFieldStale,
  markStale,
  plan,
  tombstone,
  updateRemote,
  writeEntity,
  type RemoteMessage,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
const Data = Remote.make({ entities: [User] })
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)
const UserSummary = Selection.make(User, { id: true, name: true })
const UserPage = Surface.make(App, 'UserPage', {
  Params: Schema.Struct({ userId: Schema.String }),
  model: ({ params }) =>
    Projection.struct({ user: Remote.select(AppRemote, UserSummary)(params.userId) }),
  messages: [Message.Ping],
})

const key = entityKey('User', 'u1')
const requirement = { entity: 'User', id: 'u1', fields: ['id', 'name'] }
const known = writeEntity(emptyStore, key, { id: 'u1', name: 'ada' }, 0)
const root = (store = emptyStore) => ({ remote: { ...initialRemoteModel, entities: store } })

const calls: Array<unknown> = []
const FakeClient = Layer.succeed(RemoteClient, {
  read: batch =>
    Effect.sync(() => {
      calls.push(batch)
      return {
        entities: batch.requests.map(request => ({
          entity: request.entity,
          id: request.id,
          values: { id: request.id, name: 'grace' },
        })),
      }
    }),
  query: () => Effect.die('unused'),
  mutate: () => Effect.die('unused'),
  live: () => Stream.empty,
})

const collect = async (
  policy: ReturnType<typeof RemotePolicy.staleWhileRevalidate>,
  store = known,
  now = () => 1000,
) => {
  calls.length = 0
  const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, message => message, {
    policy,
    now,
  })
  const dependencies = entry.modelToDependencies(root(store))
  const messages = await Effect.runPromise(
    Stream.runCollect(entry.dependenciesToStream(dependencies)).pipe(Effect.provide(FakeClient)),
  )
  return { dependencies, messages: [...messages] as RemoteMessage[] }
}

describe('plan with force', () => {
  it('plans every field, present or tombstoned', () => {
    expect(plan(known, [requirement], { force: true })).toEqual([requirement])
    expect(plan(tombstone(emptyStore, key), [requirement], { force: true })).toEqual([requirement])
    expect(plan(known, [requirement])).toEqual([])
  })

  it('carries the window of a forced relation field', () => {
    const windows = { posts: { first: 10 } }
    expect(
      plan(known, [{ entity: 'User', id: 'u1', fields: ['name', 'posts'], windows }], {
        force: true,
      }),
    ).toEqual([{ entity: 'User', id: 'u1', fields: ['name', 'posts'], windows }])
  })
})

describe('RemotePolicy', () => {
  it('compiles to planner options', () => {
    expect(RemotePolicy.toPlan(RemotePolicy.cacheFirst, 5)).toEqual({})
    expect(RemotePolicy.toPlan(RemotePolicy.staleWhileRevalidate({ maxAge: 30 }), 5)).toEqual({
      freshness: { now: 5, freshness: 30 },
    })
    expect(RemotePolicy.toPlan(RemotePolicy.networkOnly, 5)).toEqual({ force: true })
  })

  it('only cache-first never refreshes present fields', () => {
    expect(RemotePolicy.refreshes(RemotePolicy.cacheFirst)).toBe(false)
    expect(RemotePolicy.refreshes(RemotePolicy.staleWhileRevalidate({ maxAge: 1 }))).toBe(true)
    expect(RemotePolicy.refreshes(RemotePolicy.networkOnly)).toBe(true)
  })
})

describe('RefreshStarted', () => {
  it('marks the requested present fields stale and leaves absent ones alone', () => {
    const model = updateRemote(
      { ...initialRemoteModel, entities: known },
      { _tag: 'RefreshStarted', requests: [{ entity: 'User', id: 'u1', fields: ['name', 'x'] }] },
    )
    expect(isFieldStale(model.entities, key, 'name')).toBe(true)
    expect(isFieldStale(model.entities, key, 'id')).toBe(false)
    expect(model.entities[key]?.present.has('x')).toBe(false)
  })

  it('is cleared by the read that lands', () => {
    const started = updateRemote(
      { ...initialRemoteModel, entities: known },
      { _tag: 'RefreshStarted', requests: [requirement] },
    )
    const landed = updateRemote(started, {
      _tag: 'ReadReceived',
      requests: [requirement],
      result: { entities: [{ entity: 'User', id: 'u1', values: { id: 'u1', name: 'grace' } }] },
      now: 7,
    })
    expect(isFieldStale(landed.entities, key, 'name')).toBe(false)
    expect(landed.entities[key]?.values.name).toBe('grace')
  })
})

describe('Remote.select under refresh', () => {
  const projection = Remote.select(AppRemote, UserSummary)('u1')

  it('reads Ready when nothing is stale and Refreshing when a selected field is', () => {
    expect(projection.read(root(known))).toEqual({
      _tag: 'Ready',
      value: { id: 'u1', name: 'ada' },
    })
    expect(projection.read(root(markStale(known, key, ['name'])))).toEqual({
      _tag: 'Refreshing',
      value: { id: 'u1', name: 'ada' },
    })
  })

  it('a stale field outside the selection does not read as Refreshing', () => {
    const store = markStale(writeEntity(known, key, { email: 'a@b.c' }, 0), key, ['email'])
    expect(projection.read(root(store))._tag).toBe('Ready')
  })
})

describe('Remote.observe policies', () => {
  it('cache-first plans nothing for a known Surface and never emits RefreshStarted', async () => {
    const { dependencies, messages } = await collect(RemotePolicy.cacheFirst)
    expect(dependencies.requirements).toEqual([])
    expect(messages).toEqual([])

    const first = await collect(RemotePolicy.cacheFirst, emptyStore)
    expect(first.messages.map(message => message._tag)).toEqual(['ReadReceived'])
  })

  it('stale-while-revalidate refetches an expired entry behind RefreshStarted', async () => {
    const policy = RemotePolicy.staleWhileRevalidate({ maxAge: 100 })
    const fresh = await collect(policy, known, () => 50)
    expect(fresh.dependencies.requirements).toEqual([])
    expect(calls).toHaveLength(0)

    const expired = await collect(policy, known, () => 500)
    expect(expired.dependencies.requirements).toEqual([requirement])
    expect(expired.messages.map(message => message._tag)).toEqual([
      'RefreshStarted',
      'ReadReceived',
    ])
    expect(calls).toHaveLength(1)
  })

  it('network-only plans every field even when the Surface is known', async () => {
    const { dependencies, messages } = await collect(RemotePolicy.networkOnly)
    expect(dependencies.requirements).toEqual([requirement])
    expect(messages.map(message => message._tag)).toEqual(['RefreshStarted', 'ReadReceived'])
  })

  it('reads Refreshing between RefreshStarted and ReadReceived, then Ready', async () => {
    const { messages } = await collect(RemotePolicy.networkOnly)
    const projection = Remote.select(AppRemote, UserSummary)('u1')
    let model = { ...initialRemoteModel, entities: known }
    expect(projection.read({ remote: model })._tag).toBe('Ready')
    model = updateRemote(model, messages[0]!)
    expect(projection.read({ remote: model })).toEqual({
      _tag: 'Refreshing',
      value: { id: 'u1', name: 'ada' },
    })
    model = updateRemote(model, messages[1]!)
    expect(projection.read({ remote: model })).toEqual({
      _tag: 'Ready',
      value: { id: 'u1', name: 'grace' },
    })
  })

  it('stamps ReadReceived with the injected clock', async () => {
    const { messages } = await collect(RemotePolicy.networkOnly, known, () => 4242)
    const received = messages[1]
    expect(received?._tag === 'ReadReceived' && received.now).toBe(4242)
  })

  it('a refresh marks the same fields the plan requested, so dependencies stay put', async () => {
    const policy = RemotePolicy.staleWhileRevalidate({ maxAge: 100 })
    const { dependencies, messages } = await collect(policy, known, () => 500)
    const entry = Remote.observe(AppRemote, UserPage, { userId: 'u1' }, message => message, {
      policy,
      now: () => 500,
    })
    const started = updateRemote({ ...initialRemoteModel, entities: known }, messages[0]!)
    expect(entry.modelToDependencies({ remote: started })).toEqual(dependencies)
  })
})

describe('Remote.prefetch policies', () => {
  it('refetches a known projection under network-only and returns the new values', async () => {
    calls.length = 0
    const projection = Remote.select(AppRemote, UserSummary)('u1')
    const store = await Effect.runPromise(
      Remote.prefetch(AppRemote, root(known), projection, {
        policy: RemotePolicy.networkOnly,
      }).pipe(Effect.provide(FakeClient)),
    )
    expect(calls).toHaveLength(1)
    expect(store[key]?.values.name).toBe('grace')
  })

  it('honours stale-while-revalidate against the injected clock', async () => {
    calls.length = 0
    const projection = Remote.select(AppRemote, UserSummary)('u1')
    const policy = RemotePolicy.staleWhileRevalidate({ maxAge: 100 })
    await Effect.runPromise(
      Remote.prefetch(AppRemote, root(known), projection, { policy, now: () => 50 }).pipe(
        Effect.provide(FakeClient),
      ),
    )
    expect(calls).toHaveLength(0)
    await Effect.runPromise(
      Remote.prefetch(AppRemote, root(known), projection, { policy, now: () => 500 }).pipe(
        Effect.provide(FakeClient),
      ),
    )
    expect(calls).toHaveLength(1)
  })
})
