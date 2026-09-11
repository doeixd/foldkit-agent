import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Entity, Selection } from '../src/index.js'

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

  it('supports a recursive relation by name without inlining the target', () => {
    const codec = Entity.refTo('Node')
    expect(Schema.decodeSync(codec)('Node:n1')).toEqual({ entity: 'Node', id: 'n1' })
    expect(Schema.encodeSync(codec)({ entity: 'Node', id: 'n1' })).toBe('Node:n1')
  })
})
