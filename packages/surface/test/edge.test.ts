import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, it } from 'vitest'
import { Projection, Surface } from '../src/index.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const App = Surface.application({ Model, Message: defineMessageUnion({ Ping: {} }) })

const example = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: null }

describe('Surface edge cases', () => {
  it('Projection.fromReader carries no dependencies or requirements by default', () => {
    const reader = Projection.fromReader(
      Schema.Struct({ doubled: Schema.Number }),
      (model: { readonly n: number }) => ({ doubled: model.n * 2 }),
    )

    expect(reader.read({ n: 2 })).toEqual({ doubled: 4 })
    expect(reader.dependencies).toEqual([])
    expect(reader.requirements).toEqual([])
  })

  it('Projection.array over an empty array is an empty projection', () => {
    const summary = Projection.of(Todo)({ title: true })
    expect(Projection.array(summary).read([])).toEqual([])
  })

  it('an out-of-range index reads as absence and setting it is a no-op', () => {
    const ref = App.model.todos.index(5)
    expect(Option.isNone(ref.get(example))).toBe(true)
    expect(ref.set(example, Option.some({ id: 'x', title: 'X' }))).toEqual(example)
  })

  it('a missing record key reads as absence; setting Some inserts it', () => {
    const model = { projects: {} as Record<string, { id: string; name: string }> }
    const ref = Surface.application({
      Model: Schema.Struct({
        projects: Schema.Record(
          Schema.String,
          Schema.Struct({ id: Schema.String, name: Schema.String }),
        ),
      }),
      Message: defineMessageUnion({ Ping: {} }),
    }).model.projects.at('p1')

    expect(Option.isNone(ref.get(model))).toBe(true)
    expect(ref.set(model, Option.some({ id: 'p1', name: 'Apollo' }))).toEqual({
      projects: { p1: { id: 'p1', name: 'Apollo' } },
    })
  })

  it('Projection.struct de-duplicates two entries on the same path', () => {
    const projection = Projection.struct({
      a: App.model.todos,
      b: App.model.todos,
    })
    expect(projection.dependencies).toEqual([['todos']])
  })
})
