import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Optimistic,
  Remote,
  cursor,
  edge,
  emptyConnection,
  initialRemoteModel,
  merge,
  segment,
  terminal,
  updateRemote,
  type LiveEvent,
  type RemoteModel,
} from '../src/index.js'

const Comment = Entity.make('Comment', Schema.Struct({ id: Schema.String }))
const feed = 'Feed'
const known = merge(
  emptyConnection,
  segment(
    [edge({ entity: 'Comment', id: 'c1' }), edge({ entity: 'Comment', id: 'c2' })],
    cursor('k0'),
    cursor('k1'),
  ),
)
const model = (): RemoteModel => ({ ...initialRemoteModel, connections: { [feed]: known } })
const visible = (state: RemoteModel) => Remote.visibleItems(state, feed).map(item => item.ref.id)
const live = (state: RemoteModel, event: LiveEvent) =>
  updateRemote(state, { _tag: 'LiveReceived', stream: 's', event, now: 0 })
const removeC1 = (at: number): LiveEvent => ({
  _tag: 'ConnectionRemove',
  connection: feed,
  edge: edge({ entity: 'Comment', id: 'c1' }),
  cursor: at,
})
const page = (...ids: string[]) =>
  segment(
    ids.map(id => edge({ entity: 'Comment', id })),
    cursor('k0'),
    cursor('k1'),
  )

describe('live removal and deletion', () => {
  it('a live removal hides a server-known edge', () => {
    expect(visible(live(model(), removeC1(1)))).toEqual(['c2'])
  })

  it('a replayed removal is a no-op', () => {
    const once = live(model(), removeC1(1))
    const twice = live(once, removeC1(1))
    expect(twice).toEqual(once)
    expect(twice.optimistic.overlays).toHaveLength(1)
  })

  it('a deleted entity disappears from every connection that lists it', () => {
    const deleted = live(model(), {
      _tag: 'EntityDeleted',
      ref: { entity: 'Comment', id: 'c2' },
      cursor: 1,
    })
    expect(visible(deleted)).toEqual(['c1'])
    const inserted = updateRemote(deleted, {
      _tag: 'MutationStarted',
      requestId: 'r',
      optimistic: [Optimistic.prepend(feed, Comment.ref('c2'))],
    })
    expect(visible(inserted)).toEqual(['c1'])
  })

  it('an invalidated connection keeps showing its items while stale', () => {
    const stale = updateRemote(model(), { _tag: 'ConnectionInvalidated', connection: feed })
    expect(stale.connections[feed]?.stale).toBe(true)
    expect(visible(stale)).toEqual(['c1', 'c2'])
    const fresh = updateRemote(stale, { _tag: 'ConnectionRefreshed', connection: feed })
    expect(fresh.connections[feed]?.stale).toBe(false)
  })
})

describe('a merged page supersedes settled overlays', () => {
  it('brings back an edge a live removal hid', () => {
    const hidden = live(model(), removeC1(1))
    const back = updateRemote(hidden, {
      _tag: 'ConnectionMerged',
      connection: feed,
      page: page('c1', 'c2'),
    })
    expect(visible(back)).toEqual(['c1', 'c2'])
    expect(back.optimistic.overlays).toEqual([])
  })

  it('drops a live insert overlay once the page carries the edge', () => {
    const inserted = live(model(), {
      _tag: 'ConnectionInsert',
      connection: feed,
      position: 'prepend',
      edge: edge({ entity: 'Comment', id: 'c0' }),
      cursor: 1,
    })
    expect(visible(inserted)).toEqual(['c0', 'c1', 'c2'])
    const paged = updateRemote(inserted, {
      _tag: 'ConnectionMerged',
      connection: feed,
      page: segment([edge({ entity: 'Comment', id: 'c0' })], terminal, cursor('k0')),
    })
    expect(visible(paged)).toEqual(['c0', 'c1', 'c2'])
    expect(paged.optimistic.overlays).toEqual([])
  })

  it('leaves a pending request’s overlays alone', () => {
    const pending = updateRemote(model(), {
      _tag: 'MutationStarted',
      requestId: 'r1',
      optimistic: [
        Optimistic.remove(feed, Comment.ref('c1')),
        Optimistic.prepend(feed, Comment.ref('x')),
      ],
    })
    const paged = updateRemote(pending, {
      _tag: 'ConnectionMerged',
      connection: feed,
      page: page('c1', 'c2'),
    })
    expect(visible(paged)).toEqual(['x', 'c2'])
    expect(paged.optimistic.overlays).toHaveLength(2)
  })

  it('keeps an overlay for an edge the page does not carry, and touches no other connection', () => {
    const inserted = live(model(), {
      _tag: 'ConnectionInsert',
      connection: 'Other',
      position: 'append',
      edge: edge({ entity: 'Comment', id: 'c1' }),
      cursor: 1,
    })
    const paged = updateRemote(inserted, {
      _tag: 'ConnectionMerged',
      connection: feed,
      page: page('c1', 'c2'),
    })
    expect(paged.optimistic.overlays.map(overlay => overlay.connection)).toEqual(['Other'])
  })
})
