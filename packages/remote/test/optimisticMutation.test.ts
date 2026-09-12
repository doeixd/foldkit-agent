import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Mutation,
  MutationResult,
  Optimistic,
  Query,
  Remote,
  RemoteClient,
  cursor,
  edge,
  emptyConnection,
  entityKey,
  initialRemoteModel,
  merge,
  readField,
  segment,
  terminal,
  updateRemote,
  visibleItems,
  visibleStore,
  type LiveEvent,
  type RemoteModel,
} from '../src/index.js'

const Comment = Entity.make('Comment', Schema.Struct({ id: Schema.String, body: Schema.String }))
const AddComment = Mutation.make('AddComment', {
  Input: Schema.Struct({ postId: Schema.String, body: Schema.String }),
  Output: Schema.Struct({ id: Schema.String }),
})
const CommentsForPost = Query.make('CommentsForPost', {
  Input: Schema.Struct({ postId: Schema.String }),
  Result: Query.connection(Comment),
})
const Data = Remote.make({
  entities: [Comment],
  mutations: [AddComment],
  queries: [CommentsForPost],
})
const Model = Schema.Struct({ remote: Data.Model })
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.application({ Model, Message })
const AppRemote = Remote.at(Data, App.model.remote)

const feed = CommentsForPost.ref({ postId: 'p1' })
const known = merge(
  emptyConnection,
  segment(
    [edge({ entity: 'Comment', id: 'c1' }), edge({ entity: 'Comment', id: 'c2' })],
    cursor('k0'),
    cursor('k1'),
  ),
)
const withFeed = (): RemoteModel => ({
  ...initialRemoteModel,
  connections: { [feed.identity]: known },
})
const visible = (model: RemoteModel) =>
  visibleItems(model.connections[feed.identity]!, feed.identity, model.optimistic.overlays).map(
    item => item.ref.id,
  )
const body = (model: RemoteModel, id: string) =>
  readField(visibleStore(model.entities, model.optimistic), entityKey('Comment', id), 'body')

const start = (model: RemoteModel, requestId: string, tempId: string) =>
  updateRemote(model, {
    _tag: 'MutationStarted',
    requestId,
    optimistic: [
      Entity.patch(Comment.ref(tempId), { id: tempId, body: `draft ${tempId}` }),
      Optimistic.prepend(feed, Comment.ref(tempId)),
    ],
  })

describe('a mutation owns its optimistic entity layer and connection overlays', () => {
  it('shows the temporary entity and its edge while pending', () => {
    const pending = start(withFeed(), 'req-1', 'tmp-1')
    expect(body(pending, 'tmp-1')).toEqual(Option.some('draft tmp-1'))
    expect(visible(pending)).toEqual(['tmp-1', 'c1', 'c2'])
    expect(pending.mutations.pending.has('req-1')).toBe(true)
  })

  it('success settles both by the request id and records the confirmed edge once', () => {
    const settled = updateRemote(start(withFeed(), 'req-1', 'tmp-1'), {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [{ entity: 'Comment', id: 'c9', values: { id: 'c9', body: 'draft tmp-1' } }],
      connections: [Optimistic.prepend(feed, Comment.ref('c9'))],
    })
    expect(body(settled, 'tmp-1')).toEqual(Option.none())
    expect(body(settled, 'c9')).toEqual(Option.some('draft tmp-1'))
    expect(visible(settled)).toEqual(['c9', 'c1', 'c2'])
    expect(settled.optimistic.layers).toEqual([])
    expect(settled.optimistic.overlays.map(overlay => overlay.id)).toEqual(['confirmed:req-1'])

    // A retried result neither re-writes entities nor duplicates the edge.
    const retried = updateRemote(settled, {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [{ entity: 'Comment', id: 'c9', values: { body: 'retry' } }],
      connections: [Optimistic.prepend(feed, Comment.ref('c9'))],
    })
    expect(body(retried, 'c9')).toEqual(Option.some('draft tmp-1'))
    expect(visible(retried)).toEqual(['c9', 'c1', 'c2'])
    expect(retried.optimistic.overlays).toHaveLength(1)
  })

  it('failure drops both and reveals the base', () => {
    const failed = updateRemote(start(withFeed(), 'req-1', 'tmp-1'), {
      _tag: 'MutationFailed',
      requestId: 'req-1',
      error: { _tag: 'Boom', message: 'no' },
    })
    expect(body(failed, 'tmp-1')).toEqual(Option.none())
    expect(visible(failed)).toEqual(['c1', 'c2'])
    expect(failed.optimistic).toEqual({ layers: [], overlays: [] })
  })

  it('two pending prepends read newest first, and settling one keeps the other', () => {
    const two = start(start(withFeed(), 'req-1', 'tmp-1'), 'req-2', 'tmp-2')
    expect(visible(two)).toEqual(['tmp-2', 'tmp-1', 'c1', 'c2'])
    const one = updateRemote(two, {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [],
      connections: [Optimistic.prepend(feed, Comment.ref('c9'))],
    })
    expect(visible(one)).toEqual(['tmp-2', 'c9', 'c1', 'c2'])
  })

  it('a server page that includes the confirmed edge does not duplicate it', () => {
    const settled = updateRemote(start(withFeed(), 'req-1', 'tmp-1'), {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [],
      connections: [Optimistic.prepend(feed, Comment.ref('c9'))],
    })
    const paged = updateRemote(settled, {
      _tag: 'ConnectionMerged',
      connection: feed.identity,
      page: segment([edge({ entity: 'Comment', id: 'c9' })], terminal, cursor('k0')),
    })
    expect(visible(paged)).toEqual(['c9', 'c1', 'c2'])
  })

  it('a live confirmation of the same edge does not duplicate it', () => {
    const settled = updateRemote(start(withFeed(), 'req-1', 'tmp-1'), {
      _tag: 'MutationSucceeded',
      requestId: 'req-1',
      entities: [],
      connections: [Optimistic.prepend(feed, Comment.ref('c9'))],
    })
    const event: LiveEvent = {
      _tag: 'ConnectionInsert',
      connection: feed.identity,
      position: 'prepend',
      edge: edge({ entity: 'Comment', id: 'c9' }),
      cursor: 1,
    }
    const live = updateRemote(settled, { _tag: 'LiveReceived', stream: 's', event, now: 0 })
    expect(visible(live)).toEqual(['c9', 'c1', 'c2'])
  })

  it('an optimistic remove hides a known edge until it settles', () => {
    const removing = updateRemote(withFeed(), {
      _tag: 'MutationStarted',
      requestId: 'req-3',
      optimistic: [Optimistic.remove(feed, Comment.ref('c1'))],
    })
    expect(visible(removing)).toEqual(['c2'])
    const failed = updateRemote(removing, {
      _tag: 'MutationFailed',
      requestId: 'req-3',
      error: { _tag: 'Boom', message: 'no' },
    })
    expect(visible(failed)).toEqual(['c1', 'c2'])
    const confirmed = updateRemote(removing, {
      _tag: 'MutationSucceeded',
      requestId: 'req-3',
      entities: [],
      connections: [Optimistic.remove(feed, Comment.ref('c1'))],
    })
    expect(visible(confirmed)).toEqual(['c2'])
  })

  it('a live removal of an inserted edge leaves a remove overlay in place', () => {
    const removing = updateRemote(withFeed(), {
      _tag: 'MutationStarted',
      requestId: 'req-3',
      optimistic: [Optimistic.remove(feed, Comment.ref('c1'))],
    })
    const event: LiveEvent = {
      _tag: 'ConnectionRemove',
      connection: feed.identity,
      edge: edge({ entity: 'Comment', id: 'c1' }),
      cursor: 1,
    }
    const live = updateRemote(removing, { _tag: 'LiveReceived', stream: 's', event, now: 0 })
    expect(visible(live)).toEqual(['c2'])
  })

  it('a pending optimistic edge is never a duplicate of an append of the same key', () => {
    const both = updateRemote(withFeed(), {
      _tag: 'MutationStarted',
      requestId: 'req-4',
      optimistic: [
        Optimistic.prepend(feed, Comment.ref('x')),
        Optimistic.append(feed, Comment.ref('x')),
      ],
    })
    expect(visible(both)).toEqual(['x', 'c1', 'c2'])
  })

  it('accepts a connection identity string as well as a QueryRef', () => {
    expect(Optimistic.append(feed.identity, Comment.ref('z'))).toEqual(
      Optimistic.append(feed, Comment.ref('z')),
    )
  })
})

describe('Remote.mutateInto with optimistic operations', () => {
  const Client = Layer.succeed(RemoteClient, {
    read: () => Effect.die('unused'),
    query: () => Effect.die('unused'),
    mutate: request =>
      Effect.succeed({
        output: { id: 'c9' },
        entities: [{ entity: 'Comment', id: 'c9', values: { id: 'c9', body: 'hi' } }],
        connections: [
          {
            _tag: 'Insert' as const,
            connection: feed.identity,
            position: 'prepend' as const,
            edge: { entity: 'Comment', id: 'c9', key: 'Comment:c9' },
          },
        ],
      }),
    live: () => Stream.empty,
  })

  it('applies the operations, runs, and settles with the confirmed connection change', async () => {
    const result = await Effect.runPromise(
      Remote.mutateInto(
        AppRemote,
        { remote: withFeed() },
        AddComment,
        { postId: 'p1', body: 'hi' },
        'req-1',
        {
          optimistic: [
            Entity.patch(Comment.ref('tmp'), { id: 'tmp', body: 'hi' }),
            Optimistic.prepend(feed, Comment.ref('tmp')),
          ],
        },
      ).pipe(Effect.provide(Client)),
    )
    expect(result.output).toEqual({ id: 'c9' })
    expect(visible(result.model.remote)).toEqual(['c9', 'c1', 'c2'])
    expect(body(result.model.remote, 'tmp')).toEqual(Option.none())
    expect(result.model.remote.mutations.applied.has('req-1')).toBe(true)
  })

  it('Remote.mutate returns the confirmed connection changes in client shape', async () => {
    const outcome = await Effect.runPromise(
      Remote.mutate(AddComment, { postId: 'p1', body: 'hi' }, 'req-1').pipe(Effect.provide(Client)),
    )
    expect(outcome.connections).toEqual([Optimistic.prepend(feed, Comment.ref('c9'))])
  })

  it('the wire carries connection changes on a mutation result', () => {
    const result = {
      output: null,
      entities: [],
      connections: [
        {
          _tag: 'Remove',
          connection: 'Feed',
          edge: { entity: 'Comment', id: 'c1', key: 'Comment:c1' },
        },
      ],
    }
    expect(Schema.decodeUnknownSync(MutationResult)(result)).toEqual(result)
  })
})
