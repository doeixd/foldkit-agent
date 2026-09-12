import type { QueryWindow } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { shapeWindow, type WindowOptions } from '../src/index.js'

const shape = (window: QueryWindow, options?: WindowOptions) => shapeWindow(window, options)

describe('shapeWindow', () => {
  it.each([
    ['defaults to a forward page', {}, { traversal: 'forward', cursor: undefined, pageSize: 20 }],
    [
      'pages forward with first',
      { first: 25 },
      { traversal: 'forward', cursor: undefined, pageSize: 25 },
    ],
    [
      'pages forward after a cursor',
      { after: 'c' },
      { traversal: 'forward', cursor: 'c', pageSize: 20 },
    ],
    [
      'pages backward with last',
      { last: 10 },
      { traversal: 'backward', cursor: undefined, pageSize: 10 },
    ],
    [
      'pages backward before a cursor',
      { before: 'c' },
      { traversal: 'backward', cursor: 'c', pageSize: 20 },
    ],
    [
      'treats last as backward even beside first',
      { first: 25, last: 10 },
      { traversal: 'backward', cursor: undefined, pageSize: 25 },
    ],
    [
      'falls back to the default for a negative size',
      { last: -1 },
      { traversal: 'backward', cursor: undefined, pageSize: 20 },
    ],
    [
      'honors a size of zero',
      { first: 0 },
      { traversal: 'forward', cursor: undefined, pageSize: 0 },
    ],
    [
      'falls back to the default for a fractional size',
      { first: 2.5 },
      { traversal: 'forward', cursor: undefined, pageSize: 20 },
    ],
    [
      'clamps a huge requested size to the maximum',
      { first: 1_000_000 },
      { traversal: 'forward', cursor: undefined, pageSize: 100 },
    ],
  ] as const)('%s', (_label, window, expected) => {
    expect(shape(window as QueryWindow)).toEqual(expected)
  })

  it('accepts a default page size', () => {
    expect(shape({}, { defaultSize: 5 }).pageSize).toBe(5)
  })

  it('clamps to a configured maximum', () => {
    expect(shape({ first: 50 }, { maxSize: 10 }).pageSize).toBe(10)
    expect(shape({}, { defaultSize: 50, maxSize: 10 }).pageSize).toBe(10)
  })
})
