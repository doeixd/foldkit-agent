import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { pick } from '../src/index.js'

const Model = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, done: Schema.Boolean })),
  selected: Schema.NullOr(Schema.String),
})
type Model = typeof Model.Type

describe('pick', () => {
  it('projects the picked fields, keeps local fields on write, and encodes', () => {
    const shared = pick(Model, ['todos'])
    const model: Model = { todos: [{ id: 'a', done: false }], selected: 'a' }

    expect(shared.get(model)).toEqual({ todos: [{ id: 'a', done: false }] })
    expect(shared.set(model, { todos: [] })).toEqual({ todos: [], selected: 'a' })

    // The projection is the shared codec the replica persists and sends.
    const encoded = Schema.encodeSync(shared.schema)({ todos: [{ id: 'a', done: true }] })
    expect(Schema.decodeUnknownSync(shared.schema)(encoded)).toEqual({
      todos: [{ id: 'a', done: true }],
    })
  })
})
