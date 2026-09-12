import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  Entity,
  Remote,
  Selection,
  type BoundRemote,
  type RemoteModel,
  initialRemoteModel,
} from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))

describe('Remote core', () => {
  it('builds a Selection', () => {
    const selection = Selection.make(User, { id: true, name: true })
    expect(selection.entity).toBe('User')
    expect(selection.fields).toEqual(['id', 'name'])
  })

  it('names entities and builds a typed ref', () => {
    expect(User.name).toBe('User')
    expect(User.ref('u1').id).toBe('u1')
  })

  it('round-trips a relation as a reference', () => {
    const codec = Entity.ref(User)
    expect(Schema.decodeSync(codec)('User:u7')).toEqual({ entity: 'User', id: 'u7' })
    expect(Schema.encodeSync(codec)({ entity: 'User', id: 'u7' })).toBe('User:u7')
  })

  it('encodes a ref key for adapters', () => {
    expect(Entity.refKey({ entity: 'User', id: 'u7' })).toBe('User:u7')
  })

  it('decodes a relation selected as a ref', () => {
    const Owner = Entity.make('Owner', Schema.Struct({ id: Schema.String, name: Schema.String }))
    const Project = Entity.make(
      'Project',
      Schema.Struct({ id: Schema.String, owner: Entity.ref(Owner) }),
    )
    const selection = Selection.make(Project, { id: true, owner: true })

    expect(
      Schema.decodeUnknownSync(selection.schema as unknown as Schema.ConstraintDecoder<unknown>)({
        id: 'p1',
        owner: 'Owner:o1',
      }),
    ).toEqual({ id: 'p1', owner: { entity: 'Owner', id: 'o1' } })
  })

  it('supports a recursive relation by name without inlining the target', () => {
    const codec = Entity.refTo('Node')
    expect(Schema.decodeSync(codec)('Node:n1')).toEqual({ entity: 'Node', id: 'n1' })
    expect(Schema.encodeSync(codec)({ entity: 'Node', id: 'n1' })).toBe('Node:n1')
  })

  it('round-trips an id that contains the separator', () => {
    const codec = Entity.ref(User)
    const ref = User.ref('a:b:c')
    expect(Schema.encodeSync(codec)(ref)).toBe('User:a:b:c')
    expect(Schema.decodeSync(codec)('User:a:b:c')).toEqual(ref)
  })

  it('decodes a reference with no separator to an empty id', () => {
    expect(Schema.decodeSync(Entity.ref(User))('User')).toEqual({ entity: 'User', id: '' })
  })

  it('stringifies a non-string id', () => {
    const Numeric = Entity.make(
      'Numeric',
      Schema.Struct({ id: Schema.Number, value: Schema.Number }),
    )
    expect(Numeric.ref(7).id).toBe('7')
  })

  it('preserves nested selection key order, schema, and relation requirement', () => {
    const Owner = Entity.make('Owner', Schema.Struct({ id: Schema.String, name: Schema.String }))
    const Project = Entity.make(
      'Project',
      Schema.Struct({ id: Schema.String, name: Schema.String, owner: Entity.ref(Owner) }),
    )
    const selection = Selection.make(Project, {
      name: true,
      owner: Selection.make(Owner, { id: true, name: true }),
    })

    expect(selection.fields).toEqual(['name', 'owner'])
    expect(selection.relations).toEqual({ owner: { entity: 'Owner', fields: ['id', 'name'] } })
    const decoded = Schema.decodeUnknownSync(
      selection.schema as unknown as Schema.ConstraintDecoder<unknown>,
    )({
      name: 'ada',
      owner: { id: 'o1', name: 'A' },
    })
    expect(decoded).toEqual({ name: 'ada', owner: { id: 'o1', name: 'A' } })
  })

  it('builds a paginated relation selection that decodes a page of refs', () => {
    const Comment = Entity.make('Comment', Schema.Struct({ id: Schema.String }))
    const Project = Entity.make(
      'Project',
      Schema.Struct({ id: Schema.String, comments: Entity.refPage(Comment) }),
    )
    const selection = Selection.make(Project, {
      id: true,
      comments: Selection.connection(Comment, { first: 10 }),
    })

    expect(selection.connections).toEqual({ comments: { first: 10 } })
    expect(
      Schema.decodeUnknownSync(selection.schema as unknown as Schema.ConstraintDecoder<unknown>)({
        id: 'p1',
        comments: { refs: ['Comment:c1'], hasNext: true, hasPrevious: false },
      }),
    ).toEqual({
      id: 'p1',
      comments: { refs: [{ entity: 'Comment', id: 'c1' }], hasNext: true, hasPrevious: false },
    })
  })

  it('puts a relation window on the requirement', () => {
    const Comment = Entity.make('Comment', Schema.Struct({ id: Schema.String }))
    const Project = Entity.make(
      'Project',
      Schema.Struct({ id: Schema.String, comments: Entity.refPage(Comment) }),
    )
    const selection = Selection.make(Project, {
      id: true,
      comments: Selection.connection(Comment, { first: 5 }),
    })
    const bound = {
      store: { get: () => initialRemoteModel },
    } as unknown as BoundRemote<unknown, RemoteModel>

    expect(Remote.select(bound, selection)('p1').requirements).toEqual([
      {
        entity: 'Project',
        id: 'p1',
        fields: ['id', 'comments'],
        windows: { comments: { first: 5 } },
      },
    ])
  })
})
