import { Effect, Option, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Projection } from 'foldkit-surface'
import { type SnakeCase, defaultName } from '../src/naming.js'
import {
  type Message,
  type Model,
  Message as MessageUnion,
  Model as ModelSchema,
  emptyModel,
} from './todoApp.js'

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
    const definition = TodoAgent.make({
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
      definition: TodoAgent.make({
        messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
      }),
      host: {
        model: () => emptyModel,
        dispatch: (message: Message) => void dispatched.push(message),
      },
    })

    Effect.runSync(runtime.messages.dispatch('requested_create_todo', { title: 'x' }))

    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'x' }])
  })
})

describe('optional invocation', () => {
  const dispatched: Array<Message> = []
  const runtime = TodoAgent.bind({
    definition: TodoAgent.make({
      messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
    }),
    host: {
      model: () => emptyModel,
      dispatch: (message: Message) => void dispatched.push(message),
    },
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
    const signal = new AbortController().signal
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

describe('Projection context', () => {
  it('produces a context schema covering exactly the selected fields', () => {
    const definition = TodoAgent.make({
      context: Projection.of(ModelSchema)({ todos: true }),
      messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
    })

    const schema = Agent.contextSchema(definition) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['todos'])
  })

  it('reads through the runtime like a hand-written context', () => {
    const todo = { id: 'a', title: 'A', completed: false }
    const runtime = TodoAgent.bind({
      definition: TodoAgent.make({
        context: Projection.of(ModelSchema)({ todos: true }),
        messages: TodoAgent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
      }),
      host: { model: () => ({ ...emptyModel, todos: [todo] }), dispatch: () => {} },
    })

    expect(Effect.runSync(runtime.context)).toEqual({ todos: [todo] })
  })
})

describe('dispatch by Message reference', () => {
  const dispatched: Array<Message> = []
  const definition = TodoAgent.make({
    messages: TodoAgent.expose(MessageUnion, {
      RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
      RequestedRenameTodo: {
        name: 'rename_todo',
        description: 'Rename a todo',
        input: Schema.Struct({ id: Schema.String }),
        toMessage: ({ id }) => ({ id, title: 'Untitled' }),
      },
      ClearedSelection: 'Clear the selection',
    }),
  })

  const runtime = TodoAgent.bind({
    definition,
    host: {
      model: () => emptyModel,
      dispatch: (message: Message) => void dispatched.push(message),
    },
  })

  beforeEach(() => {
    dispatched.length = 0
  })

  it('accepts the Message constructor in place of its name', () => {
    const result = Effect.runSync(
      runtime.messages.dispatch(MessageUnion.RequestedCreateTodo, { title: 'Write docs' }),
    )

    expect(result.name).toBe('create_todo')
    expect(result.tag).toBe('RequestedCreateTodo')
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('reaches a capability whose name was never written down', () => {
    Effect.runSync(runtime.messages.dispatch(MessageUnion.ClearedSelection, {}))

    expect(dispatched).toEqual([{ _tag: 'ClearedSelection' }])
  })

  it('takes the external input when the variant declares one', () => {
    Effect.runSync(runtime.messages.dispatch(MessageUnion.RequestedRenameTodo, { id: 'a' }))

    expect(dispatched).toEqual([{ _tag: 'RequestedRenameTodo', id: 'a', title: 'Untitled' }])
  })

  it('agrees with dispatching by name', () => {
    const byReference = Effect.runSync(
      runtime.messages.dispatch(MessageUnion.RequestedCreateTodo, { title: 'x' }),
    )
    const byName = Effect.runSync(runtime.messages.dispatch('create_todo', { title: 'x' }))

    expect(byReference.name).toBe(byName.name)
    expect(byReference.tag).toBe(byName.tag)
  })

  it('reports a constructor the contract does not expose', () => {
    const failure = Effect.runSync(
      Effect.result(
        // A caller reaching past the types gets the same refusal as a bad name.
        runtime.messages.dispatch(MessageUnion.ReceivedTodos as never, {} as never),
      ),
    )

    expect(failure._tag).toBe('Failure')
    expect((failure as { failure: { message: string } }).failure.message).toBe(
      'No such capability: ReceivedTodos',
    )
    expect(dispatched).toEqual([])
  })
})

describe('default capability names', () => {
  /**
   * The runtime default and its type-level twin must agree exactly, or a
   * capability's name would not be the one its type says it is. Both are
   * asserted against the same table.
   */
  const expected = {
    RequestedDeleteTodo: 'requested_delete_todo',
    ClearedSelection: 'cleared_selection',
    A: 'a',
    Load2Todos: 'load2_todos',
    LoadedHTTPCache: 'loaded_h_t_t_p_cache',
  } as const

  it('normalizes a tag the same way at runtime', () => {
    for (const [tag, name] of Object.entries(expected)) {
      expect(defaultName(tag)).toBe(name)
    }
  })

  it('normalizes a tag the same way at the type level', () => {
    // Each assignment fails to compile if SnakeCase disagrees with the table.
    const checks: {
      [Tag in keyof typeof expected]: SnakeCase<Tag>
    } = expected
    expect(checks).toEqual(expected)
  })
})
