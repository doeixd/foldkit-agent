import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  cursor,
  edge,
  emptyConnection,
  emptyStore,
  entityKey,
  merge,
  readField,
  segment,
  terminal,
} from '../src/index.js'
import {
  applyConnectionEvent,
  applyEntityEvent,
  classifyLive,
  emptyLiveState,
  isStale,
  liveHasNext,
  liveHasPrevious,
  shouldWake,
} from '../src/live.js'
import { addOverlay, emptyOptimistic, visibleItems } from '../src/optimistic.js'

const ref = { entity: 'User', id: 'u1' }

describe('Live data', () => {
  it('orders events per stream, ignoring duplicates and surfacing gaps', () => {
    expect(classifyLive(emptyLiveState, 1)).toBe('applied')
    expect(classifyLive({ ...emptyLiveState, cursor: 5 }, 4)).toBe('duplicate')
    expect(classifyLive({ ...emptyLiveState, cursor: 5 }, 5)).toBe('duplicate')
    expect(classifyLive({ ...emptyLiveState, cursor: 5 }, 6)).toBe('applied')
    expect(classifyLive({ ...emptyLiveState, cursor: 5 }, 7)).toBe('gap')
  })

  it('accepts a first cursor that is not 1 (no spurious gap on subscribe)', () => {
    expect(classifyLive(emptyLiveState, 42)).toBe('applied')
    expect(classifyLive({ ...emptyLiveState, cursor: 42 }, 43)).toBe('applied')
    expect(classifyLive({ ...emptyLiveState, cursor: 42 }, 44)).toBe('gap')
    expect(classifyLive({ ...emptyLiveState, cursor: 42 }, 42)).toBe('duplicate')
  })

  it('applies entity patches and drops duplicates and gaps', () => {
    const patched = applyEntityEvent(emptyLiveState, emptyStore, {
      _tag: 'EntityPatched',
      ref,
      values: { name: 'ada' },
      changed: ['name'],
      cursor: 1,
    })
    expect(readField(patched.store, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))
    expect(patched.state.cursor).toBe(1)

    const duplicate = applyEntityEvent(patched.state, patched.store, {
      _tag: 'EntityPatched',
      ref,
      values: { name: 'grace' },
      changed: ['name'],
      cursor: 1,
    })
    expect(duplicate.outcome).toBe('duplicate')
    expect(readField(duplicate.store, entityKey('User', 'u1'), 'name')).toEqual(Option.some('ada'))

    const gap = applyEntityEvent(patched.state, patched.store, {
      _tag: 'EntityPatched',
      ref,
      values: { name: 'grace' },
      changed: ['name'],
      cursor: 3,
    })
    expect(gap.outcome).toBe('gap')
    expect(gap.state.cursor).toBe(1)
  })

  it('wakes only subscribers that select a changed field', () => {
    expect(shouldWake(['status'], ['name'])).toBe(false)
    expect(shouldWake(['status'], ['name', 'status'])).toBe(true)
    expect(shouldWake([], ['name'])).toBe(false)
  })

  it('applies each insertion policy', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1')),
    )
    const insert = (position: 'prepend' | 'append', value: number) => ({
      _tag: 'ConnectionInsert' as const,
      connection: 'Feed',
      position,
      edge: edge({ entity: 'E', id: 'x' }),
      cursor: value,
    })

    const visible = applyConnectionEvent(emptyLiveState, emptyOptimistic, insert('prepend', 1), {
      prepend: 'visible',
    })
    expect(
      visibleItems(connection, 'Feed', visible.optimistic.overlays).map(v => v.ref.id),
    ).toEqual(['x', 'a'])

    const boundary = applyConnectionEvent(emptyLiveState, emptyOptimistic, insert('prepend', 1), {
      prepend: 'boundary',
    })
    expect(
      visibleItems(connection, 'Feed', boundary.optimistic.overlays).map(v => v.ref.id),
    ).toEqual(['a'])
    expect(liveHasPrevious(connection, boundary.state, 'Feed')).toBe(true)

    const invalidate = applyConnectionEvent(emptyLiveState, emptyOptimistic, insert('prepend', 1), {
      prepend: 'invalidate',
    })
    expect(isStale(invalidate.state, 'Feed')).toBe(true)

    const ignore = applyConnectionEvent(emptyLiveState, emptyOptimistic, insert('prepend', 1), {
      prepend: 'ignore',
    })
    expect(ignore.optimistic.overlays).toEqual([])
    expect(isStale(ignore.state, 'Feed')).toBe(false)
  })

  it('a remove event removes an optimistically inserted edge', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1')),
    )
    const optimistic = addOverlay(emptyOptimistic, {
      id: 'o1',
      connection: 'Feed',
      edges: [edge({ entity: 'E', id: 'x' })],
      position: 'prepend',
    })

    const removed = applyConnectionEvent(emptyLiveState, optimistic, {
      _tag: 'ConnectionRemove',
      connection: 'Feed',
      edge: edge({ entity: 'E', id: 'x' }),
      cursor: 1,
    })
    expect(
      visibleItems(connection, 'Feed', removed.optimistic.overlays).map(v => v.ref.id),
    ).toEqual(['a'])
  })

  it('duplicates and gaps on connection events are dropped and surfaced', () => {
    const insert = (value: number) => ({
      _tag: 'ConnectionInsert' as const,
      connection: 'Feed',
      position: 'prepend' as const,
      edge: edge({ entity: 'E', id: 'x' }),
      cursor: value,
    })
    const applied = applyConnectionEvent(emptyLiveState, emptyOptimistic, insert(1), {
      prepend: 'visible',
    })
    const duplicate = applyConnectionEvent(applied.state, applied.optimistic, insert(1), {
      prepend: 'visible',
    })
    expect(duplicate.outcome).toBe('duplicate')
    expect(duplicate.optimistic.overlays).toHaveLength(1)

    const gap = applyConnectionEvent(applied.state, applied.optimistic, insert(3), {
      prepend: 'visible',
    })
    expect(gap.outcome).toBe('gap')
    expect(gap.optimistic.overlays).toHaveLength(1)
  })

  it('records an append at the boundary, visible to liveHasNext only', () => {
    const connection = merge(
      emptyConnection,
      segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1')),
    )
    const applied = applyConnectionEvent(
      emptyLiveState,
      emptyOptimistic,
      {
        _tag: 'ConnectionInsert',
        connection: 'Feed',
        position: 'append',
        edge: edge({ entity: 'E', id: 'y' }),
        cursor: 1,
      },
      { append: 'boundary' },
    )

    expect(liveHasNext(connection, applied.state, 'Feed')).toBe(true)
    expect(liveHasPrevious(connection, applied.state, 'Feed')).toBe(false)
  })

  it('a remove for an edge not in an overlay is harmless and advances the cursor', () => {
    const result = applyConnectionEvent(emptyLiveState, emptyOptimistic, {
      _tag: 'ConnectionRemove',
      connection: 'Feed',
      edge: edge({ entity: 'E', id: 'z' }),
      cursor: 1,
    })
    expect(result.state.cursor).toBe(1)
    expect(result.optimistic.overlays).toEqual([])
  })

  it('a ConnectionInvalidate marks the connection stale', () => {
    const result = applyConnectionEvent(emptyLiveState, emptyOptimistic, {
      _tag: 'ConnectionInvalidate',
      connection: 'Feed',
      cursor: 1,
    })
    expect(isStale(result.state, 'Feed')).toBe(true)
    expect(result.outcome).toBe('applied')
  })
})
