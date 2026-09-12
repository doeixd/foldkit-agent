import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Surface } from '../src/index.js'
import { App } from './todoFixture.js'

const model = { todos: [{ id: 'a', title: 'A' }], selectedTodoId: 'a' }

describe('Surface.pick', () => {
  it('derives a writable projection keyed by each reference', () => {
    const Pick = Surface.pick(App.model.todos, App.model.selectedTodoId)

    expect(Pick.dependencies).toEqual([['todos'], ['selectedTodoId']])
    expect(Pick.get(model)).toEqual({ todos: [{ id: 'a', title: 'A' }], selectedTodoId: 'a' })
    expect(Schema.decodeUnknownSync(Pick.schema)({ todos: [], selectedTodoId: null })).toEqual({
      todos: [],
      selectedTodoId: null,
    })
  })

  it('installs only the declared fields', () => {
    const Pick = Surface.pick(App.model.todos)

    expect(Pick.set(model, { todos: [] })).toEqual({ todos: [], selectedTodoId: 'a' })
    // An excess field in the untrusted value cannot reach the Model.
    expect(Pick.set(model, { todos: [], selectedTodoId: 'b' } as never)).toEqual({
      todos: [],
      selectedTodoId: 'a',
    })
  })

  it('deduplicates an identical member', () => {
    const todos = App.model.todos
    expect(Surface.pick(todos, todos).dependencies).toEqual([['todos']])
    expect(Surface.pick(todos, todos).get(model)).toEqual({ todos: model.todos })
  })

  it('rejects references from a different application with an identical Model', () => {
    const Other = Surface.application({ Model: App.Model, Message: App.Message })

    expect(() => Surface.pick(App.model.todos, Other.model.selectedTodoId)).toThrow(
      'different applications',
    )
  })
})
