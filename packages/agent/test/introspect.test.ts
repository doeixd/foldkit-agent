import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Projection } from 'foldkit-surface'
import { type Model, Message, Todo } from './todoApp.js'

const AgentContext = Schema.Struct({
  selectedTodoId: Schema.Option(Schema.String),
  todos: Schema.Array(Todo),
})

const AppAgent = Agent.define({
  context: Projection.fromReader(AgentContext, (model: Model) => ({
    selectedTodoId: model.selectedTodoId,
    todos: model.todos,
  })),

  messages: Agent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a new todo' },
    RequestedRenameTodo: { name: 'rename_todo', description: 'Rename an existing todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete a todo',
      available: (model: Model) => Option.isSome(model.selectedTodoId),
    },
  }),

  resources: [
    Agent.resource('todos', {
      description: "The user's current todos",
      schema: Schema.Array(Todo),
      read: (model: Model) => model.todos,
    }),
  ],
})

describe('introspection', () => {
  // This test is written verbatim in README.md.
  it('only intended Messages are exposed', () => {
    expect(Agent.messages(AppAgent).map(message => message.name)).toEqual([
      'create_todo',
      'rename_todo',
      'delete_todo',
    ])
  })

  // This test is written verbatim in README.md.
  it('delete_todo derives its input Schema', () => {
    const schema = Agent.schema(AppAgent)

    expect(
      schema.messages.find(message => message.name === 'delete_todo')?.inputSchema,
    ).toMatchObject({
      type: 'object',
      required: ['id'],
    })
  })

  it('never exposes an internal Message', () => {
    const names = Agent.messages(AppAgent).map(message => message.tag)
    expect(names).not.toContain('ReceivedTodos')
    expect(names).not.toContain('FailedToLoadTodos')
  })

  it('reports which capabilities are Model-dependent', () => {
    const descriptors = Agent.messages(AppAgent)
    expect(descriptors.find(d => d.name === 'delete_todo')?.modelDependent).toBe(true)
    expect(descriptors.find(d => d.name === 'create_todo')?.modelDependent).toBe(false)
  })

  it('reports which capabilities run an authorization hook', () => {
    const guarded = Agent.define({
      messages: Agent.expose(Message, {
        RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
        RequestedDeleteTodo: {
          name: 'delete_todo',
          description: 'Delete a todo',
          authorize: () => false,
        },
      }),
    })
    const descriptors = Agent.messages(guarded)
    expect(descriptors.find(d => d.name === 'delete_todo')?.requiresAuthorization).toBe(true)
    expect(descriptors.find(d => d.name === 'create_todo')?.requiresAuthorization).toBe(false)
  })

  it('derives the projected context schema, not the whole Model', () => {
    const contextSchema = Agent.contextSchema(AppAgent)
    expect(contextSchema).toMatchObject({ type: 'object' })
    expect(Object.keys((contextSchema as any).properties)).toEqual(['selectedTodoId', 'todos'])
  })

  it('describes resources as data', () => {
    expect(Agent.resources(AppAgent)).toMatchObject([
      { name: 'todos', description: "The user's current todos", schema: { type: 'array' } },
    ])
  })

  it('omits the context schema when no context is projected', () => {
    const contextless = Agent.define({
      messages: Agent.expose(Message, {
        RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
      }),
    })
    expect(Agent.contextSchema(contextless)).toBeUndefined()
    expect(Agent.schema(contextless).context).toBeUndefined()
  })

  it('rejects duplicate resource names', () => {
    const todos = Agent.resource('todos', {
      description: 'Todos',
      schema: Schema.Array(Todo),
      read: (model: Model) => model.todos,
    })
    expect(() =>
      Agent.define({
        messages: Agent.expose(Message, {
          RequestedCreateTodo: { description: 'Create a todo' },
        }),
        resources: [todos, todos],
      }),
    ).toThrow(/Duplicate agent resource name/)
  })
})
