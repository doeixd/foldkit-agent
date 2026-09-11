import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Projection, type Requirement } from '../src/index.js'

const leaf = (requirement: Requirement): Projection<unknown, unknown> => ({
  Model: Schema.Unknown as Schema.Schema<unknown>,
  dependencies: [],
  requirements: [requirement],
  read: () => null,
})

describe('Requirement windows', () => {
  it('merges windows for the same entity and id', () => {
    const projection = Projection.struct({
      a: leaf({ entity: 'E', id: 'e1', fields: ['x'], windows: { comments: { first: 5 } } }),
      b: leaf({ entity: 'E', id: 'e1', fields: ['y'], windows: { tags: { first: 9 } } }),
    })

    expect(projection.requirements).toEqual([
      {
        entity: 'E',
        id: 'e1',
        fields: ['x', 'y'],
        windows: { comments: { first: 5 }, tags: { first: 9 } },
      },
    ])
  })

  it('omits windows when there are none', () => {
    const projection = Projection.struct({
      a: leaf({ entity: 'E', id: 'e1', fields: ['x'] }),
    })

    expect(projection.requirements).toEqual([{ entity: 'E', id: 'e1', fields: ['x'] }])
  })
})
