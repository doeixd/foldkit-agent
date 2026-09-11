import { Optic, Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, it } from 'vitest'
import { ModelRef, Projection, Surface } from '../src/index.js'

const UserSchema = Schema.Struct({ id: Schema.String, name: Schema.String })

const Model = Schema.Struct({
  session: Schema.Struct({ user: Schema.Struct({ name: Schema.String }) }),
  projects: Schema.Record(Schema.String, Schema.Struct({ id: Schema.String, name: Schema.String })),
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
})
const Message = defineMessageUnion({ Ping: {} })
const App = Surface.make({ Model, Message })

const example = {
  session: { user: { name: 'ada' } },
  projects: {},
  todos: [{ id: 't1', title: 'write the spike' }],
}

describe('Surface runtime', () => {
  it('reads a nested ModelRef', () => {
    expect(App.model.session.user.name.get(example)).toBe('ada')
  })

  it('reads an array field and an indexed focus as Option', () => {
    expect(App.model.todos.get(example)).toEqual(example.todos)
    const first = App.model.todos.index(0).get(example)
    expect(Option.isSome(first)).toBe(true)
    expect(Option.getOrNull(first)).toEqual({ id: 't1', title: 'write the spike' })
    expect(Option.isNone(App.model.todos.index(9).get(example))).toBe(true)
  })

  it('sets a plain ModelRef focus without mutating the original', () => {
    const next = App.model.session.user.name.set(example, 'grace')
    expect(next).toEqual({ ...example, session: { user: { name: 'grace' } } })
    expect(example.session.user.name).toBe('ada')
  })

  it('sets and clears an optional focus', () => {
    const projectRef = App.model.projects.at('p1')
    const withProject = projectRef.set(example, Option.some({ id: 'p1', name: 'Apollo' }))
    expect(projectRef.get(withProject)).toEqual(Option.some({ id: 'p1', name: 'Apollo' }))
    const clearedProject = projectRef.set(withProject, Option.none())
    expect(projectRef.get(clearedProject)).toEqual(Option.none())

    const todoRef = App.model.todos.index(0)
    const replaced = todoRef.set(example, Option.some({ id: 't1', title: 'renamed' }))
    expect(todoRef.get(replaced)).toEqual(Option.some({ id: 't1', title: 'renamed' }))
    const removed = todoRef.set(example, Option.none())
    expect(todoRef.get(removed)).toEqual(Option.none())
    expect(removed.todos).toEqual([])
  })

  it('builds a ModelRef from a raw optic', () => {
    const ref = ModelRef.fromOptic(Schema.String, Optic.id<{ name: string }>().key('name'), [
      'name',
    ])
    expect(ref.get({ name: 'ada' })).toBe('ada')
    expect(ref.set({ name: 'ada' }, 'grace')).toEqual({ name: 'grace' })
    expect(ref.dependency).toEqual(['name'])
  })

  it('reads a Projection.of selection', () => {
    const projection = Projection.of(UserSchema)({ id: true, name: true })
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
    expect(Projection.of(UserSchema)({ id: true, name: true }).dependencies).toEqual([])

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

  it('maps a Projection over an array and an Option', () => {
    const summary = Projection.of(UserSchema)({ name: true })

    const many = Projection.array(summary)
    expect(many.read([{ id: 'u1', name: 'ada' }])).toEqual([{ name: 'ada' }])

    const maybe = Projection.option(summary)
    expect(maybe.read(Option.some({ id: 'u1', name: 'ada' }))).toEqual(Option.some({ name: 'ada' }))
    expect(maybe.read(Option.none())).toEqual(Option.none())

    // Explicit nesting: no flattening, no double-wrap.
    const nested = Projection.array(Projection.array(summary))
    expect(nested.read([[{ id: 'u1', name: 'ada' }]])).toEqual([[{ name: 'ada' }]])

    // Dependencies pass through unchanged.
    const selected = Projection.array(Projection.struct({ name: App.model.session.user.name }))
    expect(selected.dependencies).toEqual([['session', 'user', 'name']])
  })

  it('selects a Projection through a ModelRef and preserves optional absence', () => {
    const projectSchema = Schema.Struct({ id: Schema.String, name: Schema.String })
    const nameOnly = Projection.of(projectSchema)({ name: true })

    const selected = App.model.projects.at('p1').select(nameOnly)
    expect(selected.dependencies).toEqual([['projects', 'p1']])

    const withProject = { ...example, projects: { p1: { id: 'p1', name: 'Apollo' } } }
    expect(selected.read(withProject)).toEqual(Option.some({ name: 'Apollo' }))
    expect(selected.read({ ...example, projects: {} })).toEqual(Option.none())
  })

  it('rejects duplicate Surface names in a registry', () => {
    const model = () => Projection.struct({ name: App.model.session.user.name })
    const a = Surface.define(App, 'Card', { model, messages: [Message.Ping] })
    const b = Surface.define(App, 'Card', { model, messages: [Message.Ping] })

    expect(() => Surface.registry(App, [a, b])).toThrow('Duplicate Surface name: Card')
    expect(Surface.registry(App, [a]).surfaces).toEqual([a])
  })

  it('treats an empty selection as a strict empty object', () => {
    // `Projection.Model` is the narrow `Schema.Schema` view; decode at the test
    // boundary needs the full codec.
    const decode = (schema: Schema.Schema<unknown>, input: unknown) =>
      Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>)(input)

    const empty = Projection.of(UserSchema)({})
    expect(empty.read({ id: 'u1', name: 'ada' })).toEqual({})
    expect(decode(empty.Model, {})).toEqual({})
    expect(() => decode(empty.Model, { id: 'u1' })).toThrow()
  })

  it('rejects a Model field whose name collides with a ModelRef member', () => {
    const Bad = Schema.Struct({ at: Schema.String })
    expect(() => Surface.make({ Model: Bad, Message })).toThrow('reserved by ModelRef')
  })
})
