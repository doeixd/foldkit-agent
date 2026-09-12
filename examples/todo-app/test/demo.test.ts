import { Agent } from 'foldkit-agent'
import { describe, expect, it } from 'vitest'
import { AppAgent } from '../src/agent.js'
import { Message, initialModel, replay, update, visibleTodos } from '../src/app.js'
import { runDemo } from '../src/demo.js'

describe('the todo app', () => {
  it('runs the whole transcript', async () => {
    const transcript = (await runDemo()).join('\n')

    expect(transcript).toContain('add_todo <- SubmittedTodo: Add a todo with the given title')
    expect(transcript).toContain(
      'registered tools: add_todo, toggle_todo, rename_todo, delete_todo, clear_completed',
    )
    expect(transcript).toContain('From the browser agent')
    expect(transcript).toContain('refused: Message is local-only')
  })

  it('exposes exactly the durable Messages', () => {
    const tags = Agent.messages(AppAgent)
      .map(capability => capability.tag)
      .sort()
    expect(tags).toEqual([
      'ClearedCompleted',
      'DeletedTodo',
      'RenamedTodo',
      'SubmittedTodo',
      'ToggledTodo',
    ])
  })

  it('keeps a local Message out of replay', () => {
    expect(() => replay(initialModel, Message.FilterSelected({ filter: 'active' }))).toThrow(
      'local-only',
    )
  })

  it('toggles and filters the visible todos', () => {
    const added = update(initialModel, Message.SubmittedTodo({ id: 'a', title: 'a' })).model
    const done = update(added, Message.ToggledTodo({ id: 'a' })).model

    expect(visibleTodos(done)).toHaveLength(1)
    expect(visibleTodos({ ...done, filter: 'active' })).toHaveLength(0)
    expect(visibleTodos({ ...done, filter: 'completed' })).toHaveLength(1)
  })
})
