/**
 * Features in combination. Each case exercises an interaction that the
 * single-feature tests cannot reach: which check wins when two apply, and what
 * a later feature sees of an earlier one's output.
 */
import { Effect, Option, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Projection } from 'foldkit-surface'
import { type Message, type Model, Message as MessageUnion, Todo, emptyModel } from './todoApp.js'

const TodoAgent = Agent.forModel<Model, { readonly canWrite: boolean }>()

let model: Model
let dispatched: Array<Message>
let principal: { readonly canWrite: boolean }
/** Every hook records its name here, so ordering is observable. */
let calls: Array<string>

beforeEach(() => {
  model = emptyModel
  dispatched = []
  principal = { canWrite: true }
  calls = []
})

const host = {
  model: () => {
    calls.push('model')
    return model
  },
  dispatch: (message: Message) => {
    calls.push('dispatch')
    dispatched.push(message)
  },
  principal: () => principal,
}

const invocation = { id: 'inv-1', transport: 'webmcp' as const }

const failureOf = <A, E>(effect: Effect.Effect<A, E>): { readonly _tag: string } => {
  const result = Effect.runSync(Effect.result(effect))
  if (result._tag !== 'Failure') {
    throw new Error(`Expected a failure, got success: ${JSON.stringify(result)}`)
  }
  return result.failure as { readonly _tag: string }
}

describe('available + authorize', () => {
  /** One capability guarded by both, so precedence between them is observable. */
  const definition = TodoAgent.define({
    messages: TodoAgent.expose(MessageUnion, {
      RequestedDeleteTodo: {
        name: 'delete_todo',
        description: 'Delete the selected todo',
        available: model => {
          calls.push('available')
          return Option.isSome(model.selectedTodoId)
        },
        authorize: ({ principal }) => {
          calls.push('authorize')
          return principal.canWrite
        },
      },
    }),
  })

  const runtime = () => TodoAgent.bind({ definition, host })

  it('reports unavailability before consulting authorization', () => {
    principal = { canWrite: false }

    const failure = failureOf(runtime().messages.dispatch('delete_todo', { id: 'a' }, invocation))

    // Both would reject. The capability must not even appear to exist.
    expect(failure._tag).toBe('AgentCapabilityUnavailableError')
    expect(calls).not.toContain('authorize')
  })

  it('still refuses an available capability the principal may not use', () => {
    model = { ...emptyModel, selectedTodoId: Option.some('a') }
    principal = { canWrite: false }

    const failure = failureOf(runtime().messages.dispatch('delete_todo', { id: 'a' }, invocation))

    expect(failure._tag).toBe('AgentAuthorizationError')
    expect(dispatched).toEqual([])
  })

  it('dispatches only when both hold', () => {
    model = { ...emptyModel, selectedTodoId: Option.some('a') }

    Effect.runSync(runtime().messages.dispatch('delete_todo', { id: 'a' }, invocation))

    expect(dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'a' }])
    expect(calls).toEqual(['model', 'available', 'authorize', 'dispatch'])
  })
})

describe('input mapping + authorize', () => {
  /**
   * `authorize` must see the decoded external input, not the internal Message,
   * or a rule written against the tool's own schema would read undefined.
   */
  const seen: Array<unknown> = []

  const definition = TodoAgent.define({
    messages: TodoAgent.expose(MessageUnion, {
      RequestedRenameTodo: {
        name: 'rename_todo',
        description: 'Rename a todo',
        input: Schema.Struct({ id: Schema.String }),
        toMessage: ({ id }, { invocation }) => ({ id, title: `Renamed by ${invocation.id}` }),
        authorize: ({ input }: { input: { readonly id: string } }) => {
          seen.push(input)
          return true
        },
      },
    }),
  })

  it('authorizes the external input and dispatches the mapped Message', () => {
    seen.length = 0

    Effect.runSync(
      TodoAgent.bind({ definition, host }).messages.dispatch(
        'rename_todo',
        { id: 'a' },
        invocation,
      ),
    )

    expect(seen).toEqual([{ id: 'a' }])
    expect(dispatched).toEqual([
      { _tag: 'RequestedRenameTodo', id: 'a', title: 'Renamed by inv-1' },
    ])
  })

  it('rejects a field the external schema does not declare', () => {
    const failure = failureOf(
      TodoAgent.bind({ definition, host }).messages.dispatchUnknown(
        'rename_todo',
        { id: 'a', title: 'Injected by the agent' },
        invocation,
      ),
    )

    // toMessage owns the title; an agent must not be able to supply one.
    expect(failure._tag).toBe('AgentInvalidInputError')
    expect(dispatched).toEqual([])
  })
})

describe('input mapping + available + introspection', () => {
  const definition = TodoAgent.define({
    context: Projection.fromReader(Schema.Struct({ todos: Schema.Array(Todo) }), model => ({
      todos: model.todos,
    })),
    messages: TodoAgent.expose(MessageUnion, {
      RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
      RequestedRenameTodo: {
        name: 'rename_todo',
        description: 'Rename a todo',
        input: Schema.Struct({ id: Schema.String }),
        toMessage: ({ id }) => ({ id, title: 'Untitled' }),
        available: model => model.todos.length > 0,
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

  it('advertises the external schema, not the internal payload', () => {
    const descriptor = Agent.messages(definition).find(m => m.name === 'rename_todo')

    expect(descriptor?.inputSchema).toMatchObject({ required: ['id'] })
    expect(descriptor?.inputSchema).not.toHaveProperty('properties.title')
    expect(descriptor?.modelDependent).toBe(true)
  })

  it('keeps list stable while available follows the Model', () => {
    const runtime = TodoAgent.bind({ definition, host })
    const listed = Effect.runSync(runtime.messages.list).map(m => m.name)

    expect(listed).toEqual(['create_todo', 'rename_todo'])
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toEqual(['create_todo'])

    model = { ...emptyModel, todos: [{ id: 'a', title: 'A', completed: false }] }

    // list is the whole contract and does not move; available is a projection.
    expect(Effect.runSync(runtime.messages.list).map(m => m.name)).toEqual(listed)
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toEqual([
      'create_todo',
      'rename_todo',
    ])
  })

  it('reads context and resources from the same Model the capabilities see', () => {
    const runtime = TodoAgent.bind({ definition, host })
    const todo = { id: 'a', title: 'A', completed: false }
    model = { ...emptyModel, todos: [todo] }

    expect(Effect.runSync(runtime.context)).toEqual({ todos: [todo] })
    expect(Effect.runSync(runtime.resources.read('todos'))).toEqual([todo])
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toContain('rename_todo')
  })
})

describe('two runtimes over one definition', () => {
  /** Adapters bind independently; one binding must not observe another's host. */
  const definition = TodoAgent.define({
    messages: TodoAgent.expose(MessageUnion, {
      RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
      RequestedDeleteTodo: {
        name: 'delete_todo',
        description: 'Delete the selected todo',
        available: model => Option.isSome(model.selectedTodoId),
      },
    }),
  })

  it('keeps each binding on its own Model and dispatch', () => {
    const first: Array<Message> = []
    const second: Array<Message> = []

    const a = TodoAgent.bind({
      definition,
      host: {
        model: () => emptyModel,
        dispatch: (message: Message) => void first.push(message),
        principal: () => ({ canWrite: true }),
      },
    })
    const b = TodoAgent.bind({
      definition,
      host: {
        model: () => ({ ...emptyModel, selectedTodoId: Option.some('a') }),
        dispatch: (message: Message) => void second.push(message),
        principal: () => ({ canWrite: true }),
      },
    })

    expect(Effect.runSync(a.messages.available).map(m => m.name)).toEqual(['create_todo'])
    expect(Effect.runSync(b.messages.available).map(m => m.name)).toEqual([
      'create_todo',
      'delete_todo',
    ])

    Effect.runSync(a.messages.dispatch('create_todo', { title: 'x' }, invocation))

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})

describe('the whole contract', () => {
  it('describes messages, resources, and context in one value', () => {
    const definition = TodoAgent.define({
      context: Projection.fromReader(
        Schema.Struct({ selectedTodoId: Schema.Option(Schema.String) }),
        model => ({ selectedTodoId: model.selectedTodoId }),
      ),
      messages: TodoAgent.expose(MessageUnion, {
        RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
        ClearedSelection: { name: 'clear_selection', description: 'Clear the selection' },
      }),
      resources: [
        TodoAgent.resource('todos', {
          description: 'Current todos',
          schema: Schema.Array(Todo),
          read: model => model.todos,
        }),
      ],
    })

    expect(Agent.schema(definition)).toMatchObject({
      messages: [
        { name: 'create_todo', tag: 'RequestedCreateTodo', inputSchema: { required: ['title'] } },
        {
          name: 'clear_selection',
          tag: 'ClearedSelection',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      resources: [{ name: 'todos', schema: { type: 'array' } }],
      context: { type: 'object' },
    })
  })
})
