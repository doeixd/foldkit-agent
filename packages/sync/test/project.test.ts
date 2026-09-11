import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { describe, expect, it } from 'vitest'
import { project } from '../src/index.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const App = Surface.make({ Model, Message: defineMessageUnion({ Ping: {} }) })

describe('Sync.project', () => {
  it('derives the shared schema, get, and set from ModelRefs', () => {
    const projection = project({
      todos: App.model.todos,
      selectedTodoId: App.model.selectedTodoId,
    })
    const model = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: null }

    expect(projection.get(model)).toEqual({
      todos: [{ id: 'a', title: 'A' }],
      selectedTodoId: null,
    })
    expect(projection.set(model, { todos: [], selectedTodoId: 'x' })).toEqual({
      todos: [],
      selectedTodoId: 'x',
    })
  })

  it('projects nothing and preserves the model for an empty entry map', () => {
    const projection = project({})
    const model = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: null }

    expect(projection.get(model)).toEqual({})
    expect(projection.set(model, {})).toEqual(model)
  })

  it('set leaves fields not in the projection untouched', () => {
    const projection = project({ todos: App.model.todos })
    const model = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: 'a' }

    const next = projection.set(model, { todos: [] })
    expect(next.todos).toEqual([])
    expect(next.selectedTodoId).toBe('a')
  })
})
