import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { type Model, Message as MessageUnion, Model as ModelSchema, Todo } from './todoApp.js'

const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  context: Agent.pick(ModelSchema, ['todos']),
  messages: TodoAgent.expose(MessageUnion, {
    RequestedCreateTodo: 'Create a new todo',
    ClearedSelection: 'Clear the selection',
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: () => true,
      completion: {
        success: MessageUnion.ReceivedTodos,
        failure: MessageUnion.FailedToLoadTodos,
      },
    },
  }),
  resources: [
    TodoAgent.resource('todos', {
      description: 'Current todos',
      schema: Schema.Array(Todo),
      read: model => model.todos,
    }),
  ],
})

describe('Agent.toManifest', () => {
  it('describes every capability in declaration order', () => {
    expect(Agent.toManifest(AppAgent).capabilities.map(c => c.name)).toEqual([
      'requested_create_todo',
      'cleared_selection',
      'delete_todo',
    ])
  })

  it('records the flags and the internal tag', () => {
    const deleteTodo = Agent.toManifest(AppAgent).capabilities.find(c => c.name === 'delete_todo')

    expect(deleteTodo).toMatchObject({
      tag: 'RequestedDeleteTodo',
      description: 'Delete the selected todo',
      modelDependent: true,
      requiresAuthorization: true,
    })
  })

  it('records a completion contract by Message tag', () => {
    const deleteTodo = Agent.toManifest(AppAgent).capabilities.find(c => c.name === 'delete_todo')

    expect(deleteTodo?.completion).toEqual({
      success: ['ReceivedTodos'],
      failure: ['FailedToLoadTodos'],
    })
  })

  it('omits completion where none is declared', () => {
    const create = Agent.toManifest(AppAgent).capabilities.find(
      c => c.name === 'requested_create_todo',
    )

    expect(create).not.toHaveProperty('completion')
  })

  it('renders a payload-free capability as the closed object it advertises', () => {
    const clear = Agent.toManifest(AppAgent).capabilities.find(c => c.name === 'cleared_selection')

    expect(clear?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('is reproducible byte for byte', () => {
    // A manifest that is committed has to diff only when the contract changes.
    expect(JSON.stringify(Agent.toManifest(AppAgent))).toBe(
      JSON.stringify(Agent.toManifest(AppAgent)),
    )
  })

  it('reads nothing from the Model', () => {
    // No host is bound, so any Model access would throw rather than mislead.
    expect(() => Agent.toManifest(AppAgent)).not.toThrow()
  })

  it('handles a contract with no capabilities, resources, or context', () => {
    const empty = Agent.define({ messages: Agent.expose(MessageUnion, {}) })

    expect(Agent.toManifest(empty)).toEqual({ capabilities: [], resources: [] })
    expect(Agent.toManifest(empty)).not.toHaveProperty('context')
  })

  it('omits context when the contract projects none', () => {
    const contextless = TodoAgent.define({
      messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create' }),
    })

    expect(Agent.toManifest(contextless)).not.toHaveProperty('context')
  })
})

describe('Agent.toMarkdown', () => {
  const markdown = Agent.toMarkdown(AppAgent)

  it('lists every capability in one table', () => {
    expect(markdown).toContain('| Name | Message | Description | Model-dependent | Authorized |')
    expect(markdown).toContain('| `delete_todo` | `RequestedDeleteTodo` |')
  })

  it('says which capabilities are conditional', () => {
    expect(markdown).toContain('Available only in some Model states.')
    expect(markdown).toContain('Runs an authorization check before dispatching.')
  })

  it('includes each input schema verbatim', () => {
    for (const capability of Agent.toManifest(AppAgent).capabilities) {
      expect(markdown).toContain(JSON.stringify(capability.inputSchema, null, 2))
    }
  })

  it('names the Messages a capability completes on', () => {
    expect(markdown).toContain('Completes on `ReceivedTodos`, fails on `FailedToLoadTodos`.')
  })

  it('documents resources and the projected context', () => {
    expect(markdown).toContain('## Resources')
    expect(markdown).toContain('### `todos`')
    expect(markdown).toContain('## Context')
  })

  it('never names a Message that is not exposed', () => {
    // Internal Messages must not leak into a document that gets published.
    expect(markdown).not.toContain('RequestedRenameTodo')
  })

  it('escapes a description that would break the table', () => {
    const awkward = Agent.expose(MessageUnion, {
      RequestedCreateTodo: 'Create | delete a todo',
    })
    const rendered = Agent.toMarkdown(Agent.define({ messages: awkward }))

    expect(rendered).toContain('Create \\| delete a todo')
  })

  it('says so plainly when there is nothing to document', () => {
    const empty = Agent.define({ messages: Agent.expose(MessageUnion, {}) })
    const rendered = Agent.toMarkdown(empty)

    expect(rendered).toContain('This contract exposes no capabilities.')
    expect(rendered).toContain('This contract projects no Model context.')
    expect(rendered).not.toContain('## Resources')
  })

  it('is reproducible', () => {
    expect(Agent.toMarkdown(AppAgent)).toBe(markdown)
  })
})
