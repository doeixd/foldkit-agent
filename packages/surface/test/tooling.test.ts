import { describe, expect, it } from 'vitest'
import { Surface } from '../src/index.js'
import { App, Message, TodoList } from './todoFixture.js'

describe('Surface inspection', () => {
  it('reports what a Surface observes and emits', () => {
    const inspection = Surface.inspect(TodoList, undefined)

    expect(inspection.name).toBe('TodoList')
    expect(inspection.dependencies).toEqual([['todos'], ['selectedTodoId']])
    expect(inspection.requirements).toEqual([])
    expect(inspection.emits).toEqual([Message.CreatedTodo, Message.RenamedTodo])
  })

  it('inspects a registered Surface', () => {
    const registry = Surface.registry(App, [TodoList])
    expect(registry.surfaces).toEqual([TodoList])
    expect(Surface.inspect(registry.surfaces[0]!, undefined).name).toBe('TodoList')
  })
})
