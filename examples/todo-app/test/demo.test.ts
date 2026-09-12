import { Effect } from 'effect'
import { Agent } from 'foldkit-agent'
import { describe, expect, it } from 'vitest'
import { AppAgent } from '../src/agent.js'
import { Message, initialModel, update, visibleTodos } from '../src/app.js'
import { runDemo } from '../src/demo.js'
import { manifest, validate } from '../src/module.js'
import { stylesheet } from '../src/style.js'

describe('the todo app', () => {
  it('runs the whole transcript', async () => {
    const transcript = (await runDemo()).join('\n')

    expect(transcript).toContain('add_todo <- RequestedTodo: Add a todo with the given title')
    expect(transcript).toContain('draft after submit: ""')
    expect(transcript).toContain('completion: completed SubmittedTodo')
    expect(transcript).toContain('guest clear_completed: AgentAuthorizationError')
    expect(transcript).toContain(
      'registered tools: add_todo, toggle_todo, rename_todo, set_priority, delete_todo, clear_completed, rename_list',
    )
    expect(transcript).toContain('From the browser agent')
    expect(transcript).toContain('submit FilterSelected: InvalidOutboxError')
    expect(transcript).toContain(
      'guest RenamedList: Operation "guest-agent:1" was refused by authorization',
    )
    expect(transcript).toContain('owner RenamedList: Team')
    expect(transcript).toContain('findings: none')
    expect(transcript).toContain('filter a11y: ok')
  })

  it('exposes the intent, not the fact, plus every other durable Message', () => {
    const tags = Agent.messages(AppAgent)
      .map(capability => capability.tag)
      .sort()
    expect(tags).toEqual([
      'ClearedCompleted',
      'DeletedTodo',
      'PrioritySet',
      'RenamedList',
      'RenamedTodo',
      'RequestedTodo',
      'ToggledTodo',
    ])
  })

  it('mints the fact in a Command and keeps local state out of it', () => {
    const requested = update(initialModel, Message.RequestedTodo({ title: '  Milk ' }))
    expect(requested.model.draft).toBe('')
    expect(requested.commands).toHaveLength(1)

    const fact = update(
      { ...initialModel, draft: 'typing' },
      Message.SubmittedTodo({ id: 'a', title: 'Milk', createdAt: 1 }),
    )
    // The durable fact does not touch `draft`; only the intent did.
    expect(fact.model.draft).toBe('typing')
    expect(fact.commands).toBeUndefined()
    expect(fact.model.todos).toEqual([
      { id: 'a', title: 'Milk', completed: false, priority: 'normal', createdAt: 1 },
    ])
  })

  it('orders by priority, then age, under the filter', () => {
    let model = initialModel
    for (const [id, createdAt] of [
      ['old', 1],
      ['new', 2],
    ] as const) {
      model = update(model, Message.SubmittedTodo({ id, title: id, createdAt })).model
    }
    model = update(model, Message.PrioritySet({ id: 'new', priority: 'high' })).model
    model = update(model, Message.ToggledTodo({ id: 'old' })).model

    expect(visibleTodos(model).map(todo => todo.id)).toEqual(['new', 'old'])
    expect(visibleTodos({ ...model, filter: 'active' }).map(todo => todo.id)).toEqual(['new'])
    expect(visibleTodos({ ...model, filter: 'completed' }).map(todo => todo.id)).toEqual(['old'])
  })

  it('composes into a valid Module with one owner per shared field', () => {
    expect(validate()).toEqual([])
    const owner = (field: string) => manifest().ownership.find(row => row.path[0] === field)?.owner
    expect(owner('todos')).toEqual({ kind: 'sync', name: 'todos' })
    expect(owner('listTitle')).toEqual({ kind: 'sync', name: 'todos' })
    expect(owner('draft')).toBeUndefined()
  })

  it('compiles the rule-based styles to one deterministic stylesheet', () => {
    expect(stylesheet).toContain(':hover')
    expect(stylesheet).toContain('@media (max-width: 30rem)')
    expect(stylesheet).toBe(stylesheet.trim())
  })
})
