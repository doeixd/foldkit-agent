import { describe, expect, it } from 'vitest'
import { Surface } from '../src/index.js'
import { TodoList } from './todoFixture.js'

describe('canonical TodoList Surface', () => {
  it('reads the projected Model', () => {
    const model = { todos: [{ id: 't1', title: 'write' }], selectedTodoId: 't1' }
    expect(Surface.read(TodoList, model)).toEqual({
      todos: [{ id: 't1', title: 'write' }],
      selection: 't1',
    })
  })
})
