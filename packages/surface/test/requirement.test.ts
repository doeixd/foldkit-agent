import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Projection, Requirement } from '../src/index.js'

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

describe('Requirement relations', () => {
  const owner = { entity: 'User', fields: ['name'] }
  const ownerWithTeam = {
    entity: 'User',
    fields: ['id'],
    relations: { team: { entity: 'Team', fields: ['name'] } },
  }

  it('merges relations for the same entity and id, recursively', () => {
    const projection = Projection.struct({
      a: leaf({ entity: 'Project', id: 'p1', fields: ['owner'], relations: { owner } }),
      b: leaf({
        entity: 'Project',
        id: 'p1',
        fields: ['owner'],
        relations: { owner: ownerWithTeam },
      }),
      c: leaf({
        entity: 'Project',
        id: 'p1',
        fields: ['owner'],
        relations: {
          owner: {
            entity: 'User',
            fields: [],
            relations: { team: { entity: 'Team', fields: ['id'] } },
          },
        },
      }),
    })

    expect(projection.requirements).toEqual([
      {
        entity: 'Project',
        id: 'p1',
        fields: ['owner'],
        relations: {
          owner: {
            entity: 'User',
            fields: ['name', 'id'],
            relations: { team: { entity: 'Team', fields: ['name', 'id'] } },
          },
        },
      },
    ])
  })

  it('keeps a relation only one side declares', () => {
    expect(
      Requirement.merge([
        { entity: 'Project', id: 'p1', fields: ['name'] },
        { entity: 'Project', id: 'p1', fields: ['owner'], relations: { owner } },
      ]),
    ).toEqual([{ entity: 'Project', id: 'p1', fields: ['name', 'owner'], relations: { owner } }])
  })

  it('mergeRelations passes an absent side through', () => {
    expect(Requirement.mergeRelations(undefined, undefined)).toBeUndefined()
    expect(Requirement.mergeRelations({ owner }, undefined)).toEqual({ owner })
    expect(Requirement.mergeRelations(undefined, { owner })).toEqual({ owner })
  })

  it('later windows win inside a relation', () => {
    expect(
      Requirement.mergeRelations(
        { comments: { entity: 'Comment', fields: [], windows: { replies: { first: 1 } } } },
        { comments: { entity: 'Comment', fields: [], windows: { replies: { first: 9 } } } },
      ),
    ).toEqual({ comments: { entity: 'Comment', fields: [], windows: { replies: { first: 9 } } } })
  })
})
