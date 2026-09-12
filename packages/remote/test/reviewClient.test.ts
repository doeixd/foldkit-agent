import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  RemoteClient,
  RemotePolicy,
  RemoteReadError,
  Selection,
  addOverlay,
  cursor,
  edge,
  emptyConnection,
  emptyOptimistic,
  emptyStore,
  entityKey,
  initialRemoteModel,
  isFieldStale,
  merge,
  plan,
  segment,
  stableStringify,
  updateRemote,
  visibleItems,
  windowKey,
  writeEntity,
  type RemoteMessage,
} from '../src/index.js'

const Reply = Entity.make('Reply', Schema.Struct({ id: Schema.String, body: Schema.String }))
const Comment = Entity.make(
  'Comment',
  Schema.Struct({ id: Schema.String, body: Schema.String, replies: Entity.refPage(Reply) }),
)
const Project = Entity.make(
  'Project',
  Schema.Struct({ id: Schema.String, comments: Entity.refPage(Comment) }),
)
const Data = Remote.make({ entities: [Reply, Comment, Project] })
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const Card = Selection.make(Project, {
  comments: Selection.connection(
    Comment,
    { first: 1 },
    Selection.make(Comment, {
      body: true,
      replies: Selection.connection(Reply, { first: 2 }, Selection.make(Reply, { body: true })),
    }),
  ),
})
const requirement = Remote.select(AppRemote, Card)('p1').requirements[0]!

describe('review: nested relation windows', () => {
  const result = {
    entities: [
      {
        entity: 'Project',
        id: 'p1',
        values: { comments: { refs: ['Comment:c1'], hasNext: true, hasPrevious: false } },
      },
      {
        entity: 'Comment',
        id: 'c1',
        values: {
          body: 'hi',
          replies: { refs: ['Reply:r1', 'Reply:r2'], hasNext: true, hasPrevious: false },
        },
      },
      { entity: 'Reply', id: 'r1', values: { body: 'a' } },
      { entity: 'Reply', id: 'r2', values: { body: 'b' } },
    ],
  }

  it('are recorded on the nested target, so a different window is planned again', () => {
    const store = Remote.writeRead(emptyStore, [requirement], result, 5)
    expect(store[entityKey('Comment', 'c1')]?.windows).toEqual({
      replies: windowKey({ first: 2 }),
    })
    expect(store[entityKey('Comment', 'c1')]?.updatedAt).toBe(5)
    expect(plan(store, [requirement])).toEqual([])

    const wider = Selection.make(Project, {
      comments: Selection.connection(
        Comment,
        { first: 1 },
        Selection.make(Comment, {
          body: true,
          replies: Selection.connection(Reply, { first: 5 }, Selection.make(Reply, { body: true })),
        }),
      ),
    })
    const again = plan(store, Remote.select(AppRemote, wider)('p1').requirements)
    expect(again).toEqual([
      {
        entity: 'Comment',
        id: 'c1',
        fields: ['replies'],
        windows: { replies: { first: 5 } },
        relations: { replies: { entity: 'Reply', fields: ['body'] } },
      },
    ])
  })

  it('merges a nested "load more" page onto the stored page', () => {
    const store = Remote.writeRead(emptyStore, [requirement], result)
    const more = Selection.make(Project, {
      comments: Selection.connection(
        Comment,
        { first: 1 },
        Selection.make(Comment, {
          body: true,
          replies: Selection.connection(
            Reply,
            { first: 2, after: 'Reply:r2' },
            Selection.make(Reply, { body: true }),
          ),
        }),
      ),
    })
    const requests = plan(store, Remote.select(AppRemote, more)('p1').requirements)
    const next = Remote.writeRead(store, requests, {
      entities: [
        {
          entity: 'Comment',
          id: 'c1',
          values: { replies: { refs: ['Reply:r3'], hasNext: false, hasPrevious: true } },
        },
        { entity: 'Reply', id: 'r3', values: { body: 'c' } },
      ],
    })
    expect(next[entityKey('Comment', 'c1')]?.values.replies).toEqual({
      refs: ['Reply:r1', 'Reply:r2', 'Reply:r3'],
      hasNext: false,
      hasPrevious: true,
    })
  })
})

describe('review: prefetch stamps the store with its clock', () => {
  const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
  const UserData = Remote.make({ entities: [User] })
  const UserApp = Surface.application({
    Model: Schema.Struct({ remote: UserData.Model }),
    Message: defineMessageUnion({ Ping: {} }),
  })
  const UserRemote = Remote.at(UserData, UserApp.model.remote)
  const projection = Remote.select(UserRemote, Selection.make(User, { name: true }))('u1')
  const Client = Layer.succeed(RemoteClient, {
    read: batch =>
      Effect.succeed({
        entities: batch.requests.map(r => ({
          entity: r.entity,
          id: r.id,
          values: { name: 'ada' },
        })),
      }),
    query: () => Effect.die('unused'),
    mutate: () => Effect.die('unused'),
    live: () => Stream.empty,
  })

  it('so a stale-while-revalidate plan right after is empty', async () => {
    const policy = RemotePolicy.staleWhileRevalidate({ maxAge: 100 })
    const store = await Effect.runPromise(
      Remote.prefetch(UserRemote, { remote: initialRemoteModel }, projection, {
        policy,
        now: () => 10_000,
      }).pipe(Effect.provide(Client)),
    )
    expect(store[entityKey('User', 'u1')]?.updatedAt).toBe(10_000)
    expect(plan(store, projection.requirements, RemotePolicy.toPlan(policy, 10_050))).toEqual([])
  })
})

describe('review: a failed refresh ends', () => {
  const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))
  const UserData = Remote.make({ entities: [User] })
  const UserApp = Surface.application({
    Model: Schema.Struct({ remote: UserData.Model }),
    Message: defineMessageUnion({ Ping: {} }),
  })
  const UserRemote = Remote.at(UserData, UserApp.model.remote)
  const Page = Surface.make(UserApp, 'Page', {
    Params: Schema.Struct({ id: Schema.String }),
    model: ({ params }) =>
      Projection.struct({
        user: Remote.select(UserRemote, Selection.make(User, { name: true }))(params.id),
      }),
    messages: [],
  })
  const Failing = Layer.succeed(RemoteClient, {
    read: () => Effect.fail(new RemoteReadError({ message: 'down' })),
    query: () => Effect.die('unused'),
    mutate: () => Effect.die('unused'),
    live: () => Stream.empty,
  })

  it('reads Ready again after ReadFailed, with nothing left stale', async () => {
    const known = writeEntity(emptyStore, entityKey('User', 'u1'), { name: 'ada' }, 0)
    const entry = Remote.observe(UserRemote, Page, { id: 'u1' }, (m: RemoteMessage) => m, {
      policy: RemotePolicy.networkOnly,
    })
    const messages = await Effect.runPromise(
      Stream.runCollect(
        entry.dependenciesToStream(
          entry.modelToDependencies({ remote: { ...initialRemoteModel, entities: known } }),
        ),
      ).pipe(Effect.provide(Failing)),
    )
    let model = { ...initialRemoteModel, entities: known }
    for (const message of messages) model = updateRemote(model, message)
    expect([...messages].map(message => message._tag)).toEqual(['RefreshStarted', 'ReadFailed'])
    expect(isFieldStale(model.entities, entityKey('User', 'u1'), 'name')).toBe(false)
    expect(Page.projection({ id: 'u1' }).read({ remote: model }).user._tag).toBe('Ready')
  })
})

describe('review: overlays are ordered evidence', () => {
  const known = merge(
    emptyConnection,
    segment([edge({ entity: 'E', id: 'a' })], cursor('k0'), cursor('k1')),
  )

  it('a later insert brings back an edge an earlier remove hid', () => {
    let optimistic = addOverlay(emptyOptimistic, {
      id: 'live:1',
      connection: 'Feed',
      edges: [edge({ entity: 'E', id: 'a' })],
      position: 'remove',
    })
    expect(visibleItems(known, 'Feed', optimistic.overlays).map(e => e.ref.id)).toEqual([])
    optimistic = addOverlay(optimistic, {
      id: 'live:2',
      connection: 'Feed',
      edges: [edge({ entity: 'E', id: 'a' })],
      position: 'prepend',
    })
    expect(visibleItems(known, 'Feed', optimistic.overlays).map(e => e.ref.id)).toEqual(['a'])
    optimistic = addOverlay(optimistic, {
      id: 'live:3',
      connection: 'Feed',
      edges: [edge({ entity: 'E', id: 'a' })],
      position: 'remove',
    })
    expect(visibleItems(known, 'Feed', optimistic.overlays).map(e => e.ref.id)).toEqual([])
  })
})

describe('review: stableStringify', () => {
  it('writes undefined as null, as JSON does inside an array', () => {
    expect(stableStringify(['a', undefined])).toBe('["a",null]')
    expect(JSON.parse(stableStringify({ tags: ['a', undefined], gone: undefined }))).toEqual({
      tags: ['a', null],
    })
  })
})

describe('review: select ignores nothing it was given', () => {
  it('a plain ref selection reads Ready', () => {
    const store = writeEntity(
      writeEntity(emptyStore, entityKey('Comment', 'c1'), { body: 'x' }),
      entityKey('Project', 'p1'),
      { comments: { refs: ['Comment:c1'], hasNext: false, hasPrevious: false } },
    )
    const projection = Remote.select(
      AppRemote,
      Selection.make(Project, { comments: Selection.connection(Comment, { first: 1 }) }),
    )('p1')
    expect(projection.read({ remote: { ...initialRemoteModel, entities: store } })).toEqual({
      _tag: 'Ready',
      value: {
        comments: { refs: [{ entity: 'Comment', id: 'c1' }], hasNext: false, hasPrevious: false },
      },
    })
    expect(Option.isSome(Option.some(1))).toBe(true)
  })
})
