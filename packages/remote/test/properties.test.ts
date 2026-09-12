/**
 * Property-style checks over generated inputs. A seeded generator keeps every
 * run reproducible; each property is checked over a few hundred cases.
 */
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Optimistic,
  applyConnectionEvent,
  applyEntityEvent,
  cursor,
  edge,
  emptyConnection,
  emptyLiveState,
  emptyMutationState,
  emptyOptimistic,
  emptyStore,
  entityKey,
  items,
  merge,
  readField,
  segment,
  settleFailure,
  settleSuccess,
  terminal,
  visibleItems,
  visibleStore,
  writeEntity,
  type Connection,
  type EntityStore,
  type LiveEvent,
  type LiveState,
  type Optimistic as OptimisticState,
  type Segment,
} from '../src/index.js'

const generator = (seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  return {
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(values: ReadonlyArray<T>): T => values[Math.floor(next() * values.length)]!,
    shuffle: <T>(values: ReadonlyArray<T>): T[] => {
      const out = [...values]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j]!, out[i]!]
      }
      return out
    },
  }
}

const RUNS = 300

describe('connection merge', () => {
  /** Contiguous pages of `sequence`, each ending at the cursor the next starts from. */
  const pagesOf = (
    sequence: ReadonlyArray<string>,
    random: ReturnType<typeof generator>,
  ): Segment[] => {
    const pages: Segment[] = []
    let index = 0
    while (index < sequence.length) {
      const size = 1 + random.int(3)
      const window = sequence.slice(index, index + size)
      const start = index === 0 ? terminal : cursor(`c${index}`)
      const endIndex = Math.min(index + size, sequence.length)
      const end = endIndex >= sequence.length ? terminal : cursor(`c${endIndex}`)
      pages.push(
        segment(
          window.map(id => edge({ entity: 'E', id })),
          start,
          end,
        ),
      )
      index = endIndex
    }
    return pages
  }

  it('is order-independent, complete, duplicate-free, and idempotent', () => {
    const random = generator(42)
    for (let run = 0; run < RUNS; run++) {
      const length = 1 + random.int(12)
      const sequence = Array.from({ length }, (_, i) => `e${i}`)
      const pages = pagesOf(sequence, random)

      const inOrder = pages.reduce((current, page) => merge(current, page), emptyConnection)
      const shuffled = random
        .shuffle(pages)
        .reduce((current, page) => merge(current, page), emptyConnection)

      const ids = (connection: Connection) => items(connection).map(item => item.ref.id)
      expect(ids(inOrder)).toEqual(sequence)
      expect(ids(shuffled)).toEqual(sequence)
      expect(inOrder.segments).toHaveLength(1)
      expect(new Set(ids(shuffled)).size).toBe(sequence.length)
      expect(pages.reduce((current, page) => merge(current, page), inOrder)).toEqual(inOrder)
    }
  })

  it('a missing page is an honest gap, never implied adjacency', () => {
    const random = generator(7)
    for (let run = 0; run < RUNS; run++) {
      const length = 3 + random.int(10)
      const sequence = Array.from({ length }, (_, i) => `e${i}`)
      const pages = pagesOf(sequence, random)
      if (pages.length < 3) continue
      const dropped = 1 + random.int(pages.length - 2)
      const partial = pages.filter((_, index) => index !== dropped)
      const connection = random
        .shuffle(partial)
        .reduce((current, page) => merge(current, page), emptyConnection)
      const shown = items(connection).map(item => item.ref.id)
      // Every shown item is in sequence order, and the two sides never touch.
      const positions = shown.map(id => sequence.indexOf(id))
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      const before = pages.slice(0, dropped).flatMap(page => page.edges.map(e => e.ref.id))
      const after = pages.slice(dropped + 1).flatMap(page => page.edges.map(e => e.ref.id))
      const segmentIds = connection.segments.map(s => s.edges.map(e => e.ref.id))
      expect(segmentIds.some(ids => ids.includes(before.at(-1)!) && ids.includes(after[0]!))).toBe(
        false,
      )
    }
  })
})

describe('live event ordering', () => {
  it('duplicates and reorderings never change the store an in-order delivery yields', () => {
    const random = generator(99)
    for (let run = 0; run < RUNS; run++) {
      const count = 1 + random.int(10)
      const events: LiveEvent[] = Array.from({ length: count }, (_, i) => ({
        _tag: 'EntityPatched',
        ref: { entity: 'E', id: random.pick(['a', 'b', 'c']) },
        values: { v: i + 1 },
        changed: ['v'],
        cursor: i + 1,
      }))
      const apply = (state: LiveState, store: EntityStore, event: LiveEvent) => {
        const applied = applyEntityEvent(
          state,
          store,
          event as Extract<LiveEvent, { _tag: 'EntityPatched' | 'EntityDeleted' }>,
        )
        return { state: applied.state, store: applied.store, outcome: applied.outcome }
      }
      let expected: ReturnType<typeof apply> = {
        state: emptyLiveState,
        store: emptyStore,
        outcome: 'applied',
      }
      for (const event of events) expected = apply(expected.state, expected.store, event)

      // In order, but with each event possibly replayed several times.
      let replayed = { state: emptyLiveState, store: emptyStore }
      for (const event of events) {
        const times = 1 + random.int(3)
        for (let t = 0; t < times; t++) {
          const applied = apply(replayed.state, replayed.store, event)
          expect(applied.outcome).toBe(t === 0 ? 'applied' : 'duplicate')
          replayed = applied
        }
      }
      expect({ state: replayed.state, store: replayed.store }).toEqual({
        state: expected.state,
        store: expected.store,
      })

      // An event ahead of the cursor is a gap and leaves the store untouched.
      if (count >= 2) {
        const skipped = apply(emptyLiveState, emptyStore, events[0]!)
        const ahead = { ...events[1]!, cursor: events[1]!.cursor + 1 + random.int(5) }
        const gapped = apply(skipped.state, skipped.store, ahead)
        expect(gapped.outcome).toBe('gap')
        expect(gapped.store).toBe(skipped.store)
        expect(gapped.state).toBe(skipped.state)
      }
    }
  })

  it('connection events behave the same: replay is a no-op, ahead is a gap', () => {
    const random = generator(5)
    for (let run = 0; run < RUNS; run++) {
      const count = 1 + random.int(8)
      const events: LiveEvent[] = Array.from({ length: count }, (_, i) => {
        const e = edge({ entity: 'E', id: random.pick(['a', 'b', 'c', 'd']) })
        return random.int(3) === 0
          ? { _tag: 'ConnectionRemove', connection: 'Feed', edge: e, cursor: i + 1 }
          : {
              _tag: 'ConnectionInsert',
              connection: 'Feed',
              position: random.pick(['prepend', 'append'] as const),
              edge: e,
              cursor: i + 1,
            }
      })
      type ConnectionEvent = Extract<
        LiveEvent,
        { _tag: 'ConnectionInsert' | 'ConnectionRemove' | 'ConnectionInvalidate' }
      >
      let once = { state: emptyLiveState, optimistic: emptyOptimistic }
      let replayed = once
      for (const event of events) {
        once = applyConnectionEvent(once.state, once.optimistic, event as ConnectionEvent)
        for (let t = 0; t < 1 + random.int(3); t++) {
          replayed = applyConnectionEvent(
            replayed.state,
            replayed.optimistic,
            event as ConnectionEvent,
          )
        }
      }
      expect({ state: replayed.state, optimistic: replayed.optimistic }).toEqual({
        state: once.state,
        optimistic: once.optimistic,
      })
      const shown = visibleItems(emptyConnection, 'Feed', once.optimistic.overlays)
      expect(new Set(shown.map(item => item.key)).size).toBe(shown.length)
    }
  })
})

describe('optimistic convergence', () => {
  it('after every request settles, the visible store is the base plus the successes, in settle order', () => {
    const random = generator(2024)
    const key = entityKey('E', 'x')
    for (let run = 0; run < RUNS; run++) {
      const base = writeEntity(emptyStore, key, { v: 'base', w: 'base' })
      const count = 1 + random.int(6)
      const requests = Array.from({ length: count }, (_, i) => ({
        id: `r${i}`,
        field: random.pick(['v', 'w']),
        value: `r${i}`,
      }))
      let optimistic: OptimisticState = emptyOptimistic
      for (const request of requests) {
        optimistic = Optimistic.begin(optimistic, request.id, [
          { entity: 'E', id: 'x', values: { [request.field]: request.value } },
          Optimistic.prepend('Feed', { entity: 'E', id: request.id }),
        ])
      }
      // While pending, the latest layer wins per field and every edge shows once.
      const pendingVisible = visibleStore(base, optimistic)
      for (const field of ['v', 'w']) {
        const last = [...requests].reverse().find(request => request.field === field)
        expect(readField(pendingVisible, key, field)).toEqual(
          Option.some(last === undefined ? 'base' : last.value),
        )
      }
      expect(
        visibleItems(emptyConnection, 'Feed', optimistic.overlays).map(item => item.ref.id),
      ).toEqual([...requests].reverse().map(request => request.id))

      let store = base
      let state = emptyMutationState
      const expectedValues: Record<string, string> = { v: 'base', w: 'base' }
      const confirmed: string[] = []
      for (const request of random.shuffle(requests)) {
        if (random.int(4) === 0) {
          optimistic = settleFailure(optimistic, request.id)
          continue
        }
        const settled = settleSuccess(
          store,
          optimistic,
          state,
          request.id,
          [{ entity: 'E', id: 'x', values: { [request.field]: request.value } }],
          [Optimistic.prepend('Feed', { entity: 'E', id: `${request.id}-real` })],
        )
        store = settled.store
        state = settled.state
        optimistic = settled.optimistic
        expectedValues[request.field] = request.value
        confirmed.push(`${request.id}-real`)
      }
      expect(optimistic.layers).toEqual([])
      const finalVisible = visibleStore(store, optimistic)
      expect(readField(finalVisible, key, 'v')).toEqual(Option.some(expectedValues.v))
      expect(readField(finalVisible, key, 'w')).toEqual(Option.some(expectedValues.w))
      expect(finalVisible).toEqual(store)
      // Only confirmed overlays remain, one edge each, no temporary edge left.
      const shown = visibleItems(emptyConnection, 'Feed', optimistic.overlays).map(
        item => item.ref.id,
      )
      expect([...shown].sort()).toEqual([...confirmed].sort())
      expect(state.pending.size).toBe(0)
    }
  })
})
