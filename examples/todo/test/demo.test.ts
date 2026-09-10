import { Agent } from 'foldkit-agent'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { AppAgent, bindAgent } from '../src/agent.js'
import { Message, resetIds } from '../src/app.js'
import { runDemo } from '../src/demo.js'
import { makeStore } from '../src/store.js'

describe('the demo', () => {
  it('still demonstrates what it claims to', async () => {
    const transcript = (await runDemo()).join('\n')

    // A human and an agent drive the same state machine.
    expect(transcript).toContain('todos: Write the proposal, Ship the adapter')

    // Availability follows the Model.
    expect(transcript).toMatch(/no selection: (?!.*delete_selected_todo)/)
    expect(transcript).toMatch(/selected todo-1: .*delete_selected_todo/)

    // Availability is not authorization.
    expect(transcript).toContain('refused: Not authorized to invoke "delete_selected_todo"')
    expect(transcript).toContain('todos still: 2')

    // The WebMCP surface is derived, not written by hand.
    expect(transcript).toContain('"properties":{},"required":[],"additionalProperties":false')
    expect(transcript).toContain('tool result: Dispatched RequestedDeleteTodo')

    // A capability that is gone is unregistered.
    expect(transcript).toContain('selection: cleared by update')

    // Untrusted input never reaches update.
    expect(transcript).toContain('tool result: Invalid input for "requested_create_todo"')
  })
})

describe('the example contract', () => {
  it('exposes only the intended Messages', () => {
    expect(Agent.messages(AppAgent).map(capability => capability.tag)).toEqual([
      'RequestedCreateTodo',
      'RequestedToggleTodo',
      'SelectedTodo',
      'ClearedSelection',
      'RequestedRenameTodo',
      'RequestedDeleteTodo',
    ])
  })

  it('keeps the internal Messages internal', () => {
    const tags = Agent.messages(AppAgent).map(capability => capability.tag)
    expect(tags).not.toContain('ReceivedTodos')
    expect(tags).not.toContain('FailedToLoadTodos')
  })

  it('projects the Model without lastError', () => {
    const schema = Agent.contextSchema(AppAgent) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties).sort()).toEqual(['selectedTodoId', 'todos'])
  })

  it('drives update through the host, whichever surface originates the Message', async () => {
    resetIds()
    const store = makeStore()
    const agent = bindAgent({
      definition: AppAgent,
      host: { ...store.host, principal: () => ({ canDelete: true }) },
    })

    store.dispatch(Message.RequestedCreateTodo({ title: 'From the UI' }))
    await Effect.runPromise(
      agent.messages.dispatch(Message.RequestedCreateTodo, { title: 'From the agent' }),
    )

    expect(store.model().todos.map(todo => todo.title)).toEqual(['From the UI', 'From the agent'])
  })

  it('reads a resource off the live Model', async () => {
    const store = makeStore()
    const agent = bindAgent({
      definition: AppAgent,
      host: { ...store.host, principal: () => ({ canDelete: true }) },
    })

    store.dispatch(Message.RequestedCreateTodo({ title: 'Read me' }))

    expect(await Effect.runPromise(agent.resources.read('todos'))).toMatchObject([
      { title: 'Read me' },
    ])
  })

  it('deletes the selected todo, preserves the others, and clears the selection', async () => {
    resetIds()
    const store = makeStore()
    const agent = bindAgent({
      definition: AppAgent,
      host: { ...store.host, principal: () => ({ canDelete: true }) },
    })

    store.dispatch(Message.RequestedCreateTodo({ title: 'Keep me' }))
    store.dispatch(Message.RequestedCreateTodo({ title: 'Doomed' }))
    await Effect.runPromise(agent.messages.dispatch(Message.SelectedTodo, { id: 'todo-2' }))
    await Effect.runPromise(agent.messages.dispatch(Message.RequestedDeleteTodo, {}))

    expect(store.model().todos.map(todo => todo.id)).toEqual(['todo-1'])
    expect(Option.isNone(store.model().selectedTodoId)).toBe(true)
  })
})
