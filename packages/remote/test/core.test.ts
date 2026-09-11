import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Entity, Remote, Selection } from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))

describe('Remote core', () => {
  it('builds a Selection and starts a Remote selection as Initial', () => {
    const Data = Remote.make({ entities: [User] })
    const selection = Selection.make(User, { id: true, name: true })

    expect(Remote.select(Data, selection)).toEqual({ _tag: 'Initial' })
    expect(selection.entity).toBe('User')
  })

  it('names entities and builds a typed ref', () => {
    expect(User.name).toBe('User')
    expect(User.ref('u1').id).toBe('u1')
  })
})
