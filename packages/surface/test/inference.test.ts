import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, it } from 'vitest'
import { Entity, Projection, Remote, Selection, Surface } from '../src/index.js'

const User = Entity.make('User', Schema.Struct({ id: Schema.String, name: Schema.String }))

const Model = Schema.Struct({
  session: Schema.Struct({ user: Schema.Struct({ name: Schema.String }) }),
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
})
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.make({ Model, Message })

const example = {
  session: { user: { name: 'ada' } },
  todos: [{ id: 't1', title: 'write the spike' }],
}

describe('Phase 0 runtime smoke', () => {
  it('reads a nested ModelRef', () => {
    expect(App.model.session.user.name.read(example)).toBe('ada')
  })

  it('reads an array field and an indexed focus as Option', () => {
    expect(App.model.todos.read(example)).toEqual(example.todos)
    const first = App.model.todos.index(0).read(example)
    expect(Option.isSome(first)).toBe(true)
    expect(Option.getOrNull(first)).toEqual({ id: 't1', title: 'write the spike' })
    expect(Option.isNone(App.model.todos.index(9).read(example))).toBe(true)
  })

  it('reads a Projection.of selection', () => {
    const projection = Projection.of(User.schema)({ id: true, name: true })
    expect(Projection.read(projection, { id: 'u1', name: 'ada' })).toEqual({
      id: 'u1',
      name: 'ada',
    })
  })

  it('reads a Projection.struct over ModelRefs', () => {
    const projection = Projection.struct({ name: App.model.session.user.name })
    expect(projection.read(example)).toEqual({ name: 'ada' })
  })

  it('merges and de-duplicates projection dependencies', () => {
    // A raw-Schema projection is not a Model projection: no dependencies.
    expect(Projection.of(User.schema)({ id: true, name: true }).dependencies).toEqual([])

    const once = Projection.struct({ a: App.model.session, b: App.model.session })
    expect(once.dependencies).toEqual([['session']])

    const nested = Projection.struct({
      a: App.model.session,
      b: App.model.session.user.name,
    })
    expect(nested.dependencies).toEqual([['session'], ['session', 'user', 'name']])

    const reordered = Projection.struct({
      b: App.model.session.user.name,
      a: App.model.session,
    })
    expect(new Set(reordered.dependencies.map(path => path.join('.')))).toEqual(
      new Set(['session', 'session.user.name']),
    )
  })

  it('starts a Remote selection as Initial', () => {
    const Data = Remote.make({ entities: [User] })
    const selection = Selection.make(User, { id: true, name: true })
    expect(Remote.select(Data, selection)).toEqual({ _tag: 'Initial' })
    expect(selection.entity).toBe('User')
  })
})
