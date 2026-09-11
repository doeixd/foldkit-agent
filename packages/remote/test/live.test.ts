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
})
