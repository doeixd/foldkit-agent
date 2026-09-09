import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { type Message, type Model, Message as MessageUnion, Model as ModelSchema, emptyModel } from './todoApp.js'

const TodoAgent = Agent.forModel<Model>()

describe('description shorthand', () => {
  it('reads a bare string as the description', () => {
    const messages = Agent.expose(MessageUnion, {
      RequestedCreateTodo: 'Create a todo',
      RequestedDeleteTodo: 'Delete a todo',
    })

    expect(messages.variants.map(variant => [variant.name, variant.description])).toEqual([
      ['requested_create_todo', 'Create a todo'],
      ['requested_delete_todo', 'Delete a todo'],
    ])
  })

  it('derives the same descriptor as the object form', () => {
    const shorthand = Agent.expose(MessageUnion, { RequestedDeleteTodo: 'Delete a todo' })
    const longhand = Agent.expose(MessageUnion, {
      RequestedDeleteTodo: { description: 'Delete a todo' },
    })

    expect(shorthand.variants[0]?.inputJsonSchema).toEqual(longhand.variants[0]?.inputJsonSchema)
    expect(shorthand.variants[0]?.name).toBe(longhand.variants[0]?.name)
  })

  it('mixes with variants that need more than a description', () => {
    const definition = TodoAgent.define({
      messages: TodoAgent.expose(MessageUnion, {
        RequestedCreateTodo: 'Create a todo',
        RequestedDeleteTodo: {
          name: 'delete_todo',
          description: 'Delete the selected todo',
          available: model => Option.isSome(model.selectedTodoId),
        },
      }),
    })

    expect(Agent.messages(definition).map(m => [m.name, m.modelDependent])).toEqual([
      ['requested_create_todo', false],
      ['delete_todo', true],
    ])
  })

  it('dispatches a shorthand variant like any other', () => {
    const dispatched: Array<Message> = []
    const runtime = TodoAgent.bind({
      definition: TodoAgent.define({
        messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
      }),
      host: { model: () => emptyModel, dispatch: (message: Message) => void dispatched.push(message) },
    })

    Effect.runSync(runtime.messages.dispatch('requested_create_todo', { title: 'x' }))

    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'x' }])
  })
})

describe('optional invocation', () => {
  const dispatched: Array<Message> = []
  const runtime = TodoAgent.bind({
    definition: TodoAgent.define({
      messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
    }),
    host: { model: () => emptyModel, dispatch: (message: Message) => void dispatched.push(message) },
  })

  const dispatch = (invocation?: Partial<Agent.Invocation>) =>
    Effect.runSync(runtime.messages.dispatch('requested_create_todo', { title: 'x' }, invocation))

  it('defaults the transport to in-app and generates an id', () => {
    const result = dispatch()

    expect(result.invocation.transport).toBe('in-app')
    expect(result.invocation.id).toMatch(/\S/)
  })

  it('gives each invocation its own id', () => {
    expect(dispatch().invocation.id).not.toBe(dispatch().invocation.id)
  })

  it('keeps whatever an adapter supplies', () => {
    const signal = AbortSignal.abort()
    const result = dispatch({ id: 'adapter-id', transport: 'webmcp', signal })

    expect(result.invocation).toEqual({ id: 'adapter-id', transport: 'webmcp', signal })
  })

  it('still generates unique ids where crypto.randomUUID is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    // Non-secure contexts expose no crypto.randomUUID.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })

    try {
      const ids = new Set(Array.from({ length: 50 }, () => Agent.newInvocationId()))
      expect(ids.size).toBe(50)
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, 'crypto')
      } else {
        Object.defineProperty(globalThis, 'crypto', original)
      }
    }
  })

  it('fills in only the parts that were left out', () => {
    const result = dispatch({ transport: 'mcp' })

    expect(result.invocation.transport).toBe('mcp')
    expect(result.invocation.id).toMatch(/\S/)
  })
})

describe('Agent.pick', () => {
  it('derives the schema and the projection from one field list', () => {
    const context = Agent.pick(ModelSchema, ['todos'])
    const todo = { id: 'a', title: 'A', completed: false }

    expect(context.select({ ...emptyModel, todos: [todo] })).toEqual({ todos: [todo] })
  })

  it('projects only the named fields', () => {
    const context = Agent.pick(ModelSchema, ['selectedTodoId'])
    const projected = context.select({
      todos: [{ id: 'a', title: 'A', completed: false }],
      selectedTodoId: Option.some('a'),
    })

    expect(Object.keys(projected)).toEqual(['selectedTodoId'])
  })

  it('produces a context schema covering exactly those fields', () => {
    const definition = TodoAgent.define({
      context: Agent.pick(ModelSchema, ['todos']),
      messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
    })

    const schema = Agent.contextSchema(definition) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['todos'])
  })

  it('reads through the runtime like a hand-written context', () => {
    const todo = { id: 'a', title: 'A', completed: false }
    const runtime = TodoAgent.bind({
      definition: TodoAgent.define({
        context: Agent.pick(ModelSchema, ['todos']),
        messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
      }),
      host: { model: () => ({ ...emptyModel, todos: [todo] }), dispatch: () => {} },
    })

    expect(Effect.runSync(runtime.context)).toEqual({ todos: [todo] })
  })

  it('rejects a field the Model does not have', () => {
    // @ts-expect-error 'nope' is not a field of the Model.
    expect(() => Agent.pick(ModelSchema, ['nope'])).toThrow(/the Model has no such field/)
  })

  it('agrees with the equivalent Agent.context', () => {
    const picked = Agent.pick(ModelSchema, ['todos'])
    const written = Agent.context({
      schema: Schema.Struct({ todos: ModelSchema.fields.todos }),
      select: (model: Model) => ({ todos: model.todos }),
    })

    const model = { ...emptyModel, todos: [{ id: 'a', title: 'A', completed: false }] }
    expect(picked.select(model)).toEqual(written.select(model))
    expect(Schema.toJsonSchemaDocument(picked.schema).schema).toEqual(
      Schema.toJsonSchemaDocument(written.schema).schema,
    )
  })
})
