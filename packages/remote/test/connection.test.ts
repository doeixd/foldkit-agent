import { describe, expect, it } from 'vitest'
import {
  type Connection,
  cursor,
  edge,
  emptyConnection,
  hasNext,
  hasPrevious,
  isGapped,
  items,
  merge,
  segment,
  terminal,
  unknown,
  type Edge,
} from '../src/index.js'

const e = (id: string): Edge => edge({ entity: 'E', id })
const page = (ids: readonly string[], start = terminal, end = terminal) =>
  segment(ids.map(e), start, end)
const ids = (connection: Parameters<typeof items>[0]): ReadonlyArray<string> =>
  items(connection).map(value => value.ref.id)

describe('Connection.merge', () => {
  it('merges overlapping pages without duplication', () => {
    const first = merge(emptyConnection, page(['a', 'b', 'c', 'd'], terminal, cursor('c1')))
    const merged = merge(first, page(['c', 'd', 'e', 'f'], cursor('c1'), cursor('c2')))

    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(merged.segments).toHaveLength(1)
  })

  it('merges pages that overlap by edges even without a cursor match', () => {
    const first = merge(emptyConnection, page(['a', 'b', 'c', 'd'], cursor('x'), cursor('y')))
    const merged = merge(first, page(['c', 'd', 'e', 'f'], cursor('z'), cursor('w')))

    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('preserves a gap as separate segments', () => {
    const first = merge(emptyConnection, page(['a', 'b'], terminal, cursor('c1')))
    const gapped = merge(first, page(['i', 'j'], cursor('c2'), cursor('c3')))

    expect(isGapped(gapped)).toBe(true)
    expect(gapped.segments).toHaveLength(2)
    expect(ids(gapped)).toEqual(['a', 'b', 'i', 'j'])
  })

  it('ignores a zero-edge page so it cannot corrupt a boundary', () => {
    const connection = merge(emptyConnection, page(['a'], cursor('c1'), cursor('c2')))
    const merged = merge(connection, segment([], cursor('c2'), terminal))
    expect(merged).toEqual(connection)
  })

  it('reports no next/previous for an empty connection', () => {
    expect(hasPrevious(emptyConnection)).toBe(false)
    expect(hasNext(emptyConnection)).toBe(false)
    expect(isGapped(emptyConnection)).toBe(false)
    expect(items(emptyConnection)).toEqual([])
  })

  it('joins a page that precedes the known segment', () => {
    const connection = merge(emptyConnection, page(['c', 'd'], cursor('c1'), cursor('c2')))
    const merged = merge(connection, page(['a', 'b'], cursor('c0'), cursor('c1')))
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd'])
    expect(merged.segments).toHaveLength(1)
  })

  it('drops a page already fully contained in the known segment', () => {
    const connection = merge(emptyConnection, page(['a', 'b', 'c'], terminal, terminal))
    const merged = merge(connection, page(['b'], cursor('x'), cursor('y')))

    expect(ids(merged)).toEqual(['a', 'b', 'c'])
    expect(merged.segments).toHaveLength(1)
  })

  it('splits a segment rather than implying adjacency across a dropped interior edge', () => {
    // Deliberately inconsistent pages: `c` is already known and the second page
    // places it between `x` and `y`. Dropping `c` must not claim `x` is adjacent
    // to `y`, so the survivors become two segments with an explicit gap.
    const first = merge(emptyConnection, page(['a', 'b', 'c'], terminal, terminal))
    const second = merge(first, page(['x', 'c', 'y'], cursor('s'), cursor('e')))

    expect(ids(second)).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(second.segments).toHaveLength(3)

    const [x, y] = second.segments.slice(1)
    expect(x!.edges.map(value => value.ref.id)).toEqual(['x'])
    expect(x!.start).toEqual(cursor('s'))
    expect(x!.end).toEqual(unknown)
    expect(y!.edges.map(value => value.ref.id)).toEqual(['y'])
    expect(y!.start).toEqual(unknown)
    expect(y!.end).toEqual(cursor('e'))
  })

  it('derives hasNext/hasPrevious from boundaries, not row count', () => {
    const partial = merge(emptyConnection, page(['a'], cursor('c0'), cursor('c1')))
    expect(hasPrevious(partial)).toBe(true)
    expect(hasNext(partial)).toBe(true)

    const complete = merge(emptyConnection, page(['a'], terminal, terminal))
    expect(hasPrevious(complete)).toBe(false)
    expect(hasNext(complete)).toBe(false)
  })

  it('reports no gap for a single contiguous segment', () => {
    const contiguous = merge(emptyConnection, page(['a', 'b'], terminal, terminal))
    expect(contiguous.segments).toHaveLength(1)
    expect(isGapped(contiguous)).toBe(false)
  })

  it('uses the edge key for identity, so a repeated ref can appear twice', () => {
    const duplicateRef: Edge[] = [
      edge({ entity: 'E', id: 'a' }, 'edge-1'),
      edge({ entity: 'E', id: 'a' }, 'edge-2'),
    ]
    const merged = merge(emptyConnection, segment(duplicateRef, terminal, terminal))
    expect(items(merged)).toHaveLength(2)
  })

  it('reconstructs an overlapping paginated sequence, deterministically', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'e', 'f'] as const
    let seed = 987654321
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let run = 0; run < 200; run++) {
      const total = 3 + Math.floor(random() * 8)
      const sequence = Array.from(
        { length: total },
        () => alphabet[Math.floor(random() * alphabet.length)]!,
      )

      const pages: Array<ReturnType<typeof page>> = []
      let index = 0
      let cursorId = 0
      while (index < total) {
        const size = 1 + Math.floor(random() * 3)
        const window = sequence.slice(index, index + size)
        const start = index === 0 ? terminal : cursor(`c${cursorId - 1}`)
        const end = index + size >= total ? terminal : cursor(`c${cursorId}`)
        pages.push(page(window, start, end))
        index += Math.max(1, size - 1)
        cursorId++
      }

      const expected: string[] = []
      const seen = new Set<string>()
      for (const id of sequence) {
        const key = `E:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        expected.push(id)
      }

      const connection = pages.reduce((current, value) => merge(current, value), emptyConnection)
      expect(ids(connection)).toEqual(expected)

      // Deterministic: the same page sequence yields the same connection.
      const repeat = pages.reduce((current, value) => merge(current, value), emptyConnection)
      expect(repeat).toEqual(connection)

      // Idempotent in content: re-merging adds no new edges and no duplicates.
      const again = pages.reduce((current, value) => merge(current, value), connection)
      expect(new Set(ids(again))).toEqual(new Set(expected))
      const keys = items(again).map(value => value.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

describe('Connection segment order', () => {
  it('puts a terminal-start segment first and a terminal-end segment last, whatever the merge order', () => {
    const head = segment([edge({ entity: 'E', id: 'a' })], terminal, cursor('c1'))
    const tail = segment([edge({ entity: 'E', id: 'z' })], cursor('c8'), terminal)
    const middle = segment([edge({ entity: 'E', id: 'm' })], cursor('c4'), cursor('c5'))
    const ids = (connection: Connection) => items(connection).map(item => item.ref.id)
    expect(ids([tail, middle, head].reduce((c, p) => merge(c, p), emptyConnection))).toEqual([
      'a',
      'm',
      'z',
    ])
    expect(ids([middle, tail, head].reduce((c, p) => merge(c, p), emptyConnection))).toEqual([
      'a',
      'm',
      'z',
    ])
  })
})
