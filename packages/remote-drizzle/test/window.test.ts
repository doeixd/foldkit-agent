import type { QueryWindow } from 'foldkit-remote'
import { describe, expect, it } from 'vitest'
import { shapeWindow } from '../src/index.js'

const shape = (window: QueryWindow, defaultSize?: number) =>
  defaultSize === undefined ? shapeWindow(window) : shapeWindow(window, defaultSize)

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
    ['keeps a zero last', { last: 0 }, { traversal: 'backward', cursor: undefined, pageSize: 0 }],
  ] as const)('%s', (_label, window, expected) => {
    expect(shape(window as QueryWindow)).toEqual(expected)
  })

  it('accepts a default page size', () => {
    expect(shape({}, 5).pageSize).toBe(5)
  })
})
