import { describe, expect, it } from 'vitest'
import { buildPage } from '../src/index.js'

const a = { id: 'a' }
const b = { id: 'b' }
const c = { id: 'c' }
const cursorOf = (row: { id: string }) => row.id

describe('buildPage', () => {
  it('discards the lookahead row for a forward page', () => {
    const page = buildPage({
      rows: [a, b, c],
      pageSize: 2,
      traversal: 'forward',
      cursor: undefined,
      cursorOf,
    })

    expect(page.rows).toEqual([a, b])
    expect(page.hasNext).toBe(true)
    expect(page.hasPrevious).toBe(false)
    expect(page.nextCursor).toBe('b')
    expect(page.previousCursor).toBeUndefined()
  })

  it('reports a previous page when the forward request carried a cursor', () => {
    const page = buildPage({
      rows: [a, b],
      pageSize: 2,
      traversal: 'forward',
      cursor: 'start',
      cursorOf,
    })

    expect(page.rows).toEqual([a, b])
    expect(page.hasNext).toBe(false)
    expect(page.hasPrevious).toBe(true)
    expect(page.previousCursor).toBe('a')
  })

  it('keeps the rows nearest the cursor for a backward page', () => {
    const page = buildPage({
      rows: [a, b, c],
      pageSize: 2,
      traversal: 'backward',
      cursor: 'z',
      cursorOf,
    })

    expect(page.rows).toEqual([b, c])
    expect(page.hasPrevious).toBe(true)
    expect(page.hasNext).toBe(true)
    expect(page.nextCursor).toBe('c')
    expect(page.previousCursor).toBe('b')
  })

  it('has no previous page for the first backward page without a cursor', () => {
    const page = buildPage({
      rows: [a, b],
      pageSize: 2,
      traversal: 'backward',
      cursor: undefined,
      cursorOf,
    })

    expect(page.rows).toEqual([a, b])
    expect(page.hasPrevious).toBe(false)
    expect(page.hasNext).toBe(false)
    expect(page.previousCursor).toBeUndefined()
  })

  it('handles an empty page', () => {
    const page = buildPage({
      rows: [],
      pageSize: 10,
      traversal: 'forward',
      cursor: 'start',
      cursorOf,
    })

    expect(page).toEqual({
      rows: [],
      hasNext: false,
      hasPrevious: true,
      nextCursor: undefined,
      previousCursor: undefined,
    })
  })
})
