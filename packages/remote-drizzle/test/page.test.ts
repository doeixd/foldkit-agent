import { describe, expect, it } from 'vitest'
import { toQueryPage } from '../src/index.js'
import type { Traversal } from '../src/index.js'

const a = { id: 'a' }
const b = { id: 'b' }
const c = { id: 'c' }
const cursorOf = (row: { id: string }) => row.id

const page = (
  rows: ReadonlyArray<{ id: string }>,
  traversal: Traversal,
  pageSize: number,
  cursor: string | undefined,
) => toQueryPage({ entity: 'Project', rows, pageSize, traversal, cursor, cursorOf })

describe('toQueryPage', () => {
  it('ends a forward page at its last row when a lookahead row exists', () => {
    expect(page([a, b, c], 'forward', 2, undefined)).toEqual({
      edges: [
        { entity: 'Project', id: 'a', key: 'Project:a' },
        { entity: 'Project', id: 'b', key: 'Project:b' },
      ],
      start: { _tag: 'Terminal' },
      end: { _tag: 'Cursor', cursor: 'b' },
    })
  })

  it('starts a forward continuation at the cursor and ends terminal', () => {
    const result = page([c, { id: 'd' }], 'forward', 2, 'b')

    expect(result.edges.map(edge => edge.id)).toEqual(['c', 'd'])
    expect(result.start).toEqual({ _tag: 'Cursor', cursor: 'b' })
    expect(result.end).toEqual({ _tag: 'Terminal' })
  })

  it('brackets a forward page with both boundaries when more runs on both sides', () => {
    const result = page([c, { id: 'd' }, { id: 'e' }], 'forward', 2, 'b')

    expect(result.start).toEqual({ _tag: 'Cursor', cursor: 'b' })
    expect(result.end).toEqual({ _tag: 'Cursor', cursor: 'd' })
  })

  it('mirrors the boundaries for a backward page', () => {
    const result = page([a, b, c], 'backward', 2, 'z')

    expect(result.edges.map(edge => edge.id)).toEqual(['b', 'c'])
    expect(result.start).toEqual({ _tag: 'Cursor', cursor: 'b' })
    expect(result.end).toEqual({ _tag: 'Cursor', cursor: 'z' })
  })

  it('ends terminal for the first backward page', () => {
    const result = page([a, b], 'backward', 2, undefined)

    expect(result.edges.map(edge => edge.id)).toEqual(['a', 'b'])
    expect(result.start).toEqual({ _tag: 'Terminal' })
    expect(result.end).toEqual({ _tag: 'Terminal' })
  })

  it('keeps the requested cursor as a boundary for an empty page', () => {
    expect(page([], 'forward', 10, 'c')).toEqual({
      edges: [],
      start: { _tag: 'Cursor', cursor: 'c' },
      end: { _tag: 'Terminal' },
    })
    expect(page([], 'forward', 10, undefined).start).toEqual({ _tag: 'Terminal' })
  })
})
