import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Projection, type WritableProjection } from '../src/index.js'
import { App, Model as TodoModel } from './todoFixture.js'

type TodoModelValue = typeof TodoModel.Type
const model: TodoModelValue = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: 'a' }

const Todos = Projection.pick(App.model.todos)
const Selection = Projection.pick(App.model.selectedTodoId)

describe('Projection.compose', () => {
  it('merges disjoint picks with their codecs and dependencies', () => {
    const Both = Projection.compose(Todos, Selection)

    expect(Both.dependencies).toEqual([['todos'], ['selectedTodoId']])
    expect(Both.get(model)).toEqual({ todos: [{ id: 'a', title: 'A' }], selectedTodoId: 'a' })
    expect(Both.set(model, { todos: [], selectedTodoId: 'b' })).toEqual({
      todos: [],
      selectedTodoId: 'b',
    })
  })

  it('deduplicates an identical member', () => {
    expect(Projection.compose(Todos, Todos).dependencies).toEqual([['todos']])
  })

  it('rejects an overlapping field with a different codec', () => {
    const Conflicting: WritableProjection<TodoModelValue, { todos: Schema.Schema<string> }> = {
      schema: Schema.Struct({ todos: Schema.String }),
      dependencies: [],
      get: () => ({ todos: '' }),
      set: candidate => candidate,
    }

    expect(() => Projection.compose(Todos, Conflicting)).toThrow('conflicting definitions')
  })
})
