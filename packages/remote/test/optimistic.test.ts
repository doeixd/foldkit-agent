import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  cursor,
  edge,
  emptyConnection,
  emptyMutationState,
  emptyStore,
  entityKey,
  hasNext,
  items,
  merge,
  readField,
  segment,
  terminal,
  writeEntity,
  type EntityStore,
} from '../src/index.js'
import {
  addLayer,
  addOverlay,
  emptyOptimistic,
  removeOverlay,
  settleFailure,
  settleSuccess,
  visibleItems,
  visibleStore,
} from '../src/optimistic.js'

const user = entityKey('User', 'u1')
const name = (store: EntityStore) => readField(store, user, 'name')

describe('Optimistic layers', () => {
  it('later layers win and overlapping layers rebase on success', () => {
    const base = writeEntity(emptyStore, user, { name: 'A' })
    let optimistic = addLayer(emptyOptimistic, {
      id: 'l1',
      patches: [{ entity: 'User', id: 'u1', values: { name: 'B' } }],
    })
    optimistic = addLayer(optimistic, {
      id: 'l2',
      patches: [{ entity: 'User', id: 'u1', values: { name: 'C' } }],
    })
    expect(name(visibleStore(base, optimistic))).toEqual(Option.some('C'))

    const settled = settleSuccess(base, optimistic, emptyMutationState, 'l1', [
      { entity: 'User', id: 'u1', values: { name: 'B' } },
    ])
    expect(name(settled.store)).toEqual(Option.some('B'))
    expect(name(visibleStore(settled.store, settled.optimistic))).toEqual(Option.some('C'))
  })

  it('a failure removes exactly its layer and leaves the base untouched', () => {
    const base = writeEntity(emptyStore, user, { name: 'A' })
    let optimistic = addLayer(emptyOptimistic, {
      id: 'l1',
      patches: [{ entity: 'User', id: 'u1', values: { name: 'B' } }],
    })
    optimistic = addLayer(optimistic, {
      id: 'l2',
      patches: [{ entity: 'User', id: 'u1', values: { name: 'C' } }],
    })

    const next = settleFailure(optimistic, 'l1')
    expect(next.layers.map(layer => layer.id)).toEqual(['l2'])
    expect(name(visibleStore(base, next))).toEqual(Option.some('C'))
    expect(name(base)).toEqual(Option.some('A'))
  })

  it('does not change server-known ordering or boundaries', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1')),
    )
    const optimistic = addOverlay(emptyOptimistic, {
      id: 'o1',
      connection: 'Feed',
      position: 'append',
      edges: [edge({ entity: 'E', id: 'y' })],
    })

    expect(
      visibleItems(connection, 'Feed', optimistic.overlays).map(value => value.ref.id),
    ).toEqual(['a', 'y'])
    expect(items(connection).map(value => value.ref.id)).toEqual(['a'])
    expect(hasNext(connection)).toBe(true)
  })

  it('ignores overlays for other connections and de-duplicates repeated edges', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1')),
    )
    let optimistic = addOverlay(emptyOptimistic, {
      id: 'other',
      connection: 'Other',
      position: 'prepend',
      edges: [edge({ entity: 'E', id: 'z' })],
    })
    optimistic = addOverlay(optimistic, {
      id: 'o1',
      connection: 'Feed',
      position: 'prepend',
      edges: [edge({ entity: 'E', id: 'x' })],
    })
    optimistic = addOverlay(optimistic, {
      id: 'o2',
      connection: 'Feed',
      position: 'prepend',
      edges: [edge({ entity: 'E', id: 'x' })],
    })

    expect(
      visibleItems(connection, 'Feed', optimistic.overlays).map(value => value.ref.id),
    ).toEqual(['x', 'a'])
  })

  it('a confirmed insert removes its overlay without duplication', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], cursor('c1'), cursor('c2')),
    )
    const optimistic = addOverlay(emptyOptimistic, {
      id: 'o1',
      connection: 'Feed',
      position: 'prepend',
      edges: [edge({ entity: 'E', id: 'x' })],
    })
    expect(
      visibleItems(connection, 'Feed', optimistic.overlays).map(value => value.ref.id),
    ).toEqual(['x', 'a'])

    // The server returns the canonical page including the inserted edge.
    const confirmed = merge(
      connection,
      segment([edge({ entity: 'E', id: 'x' })], cursor('c0'), cursor('c1')),
    )
    const settled = removeOverlay(optimistic, 'o1')
    expect(visibleItems(confirmed, 'Feed', settled.overlays).map(value => value.ref.id)).toEqual([
      'x',
      'a',
    ])
  })
})
