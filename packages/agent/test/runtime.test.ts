import { Effect, Option, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { type Message, type Model, Message as MessageUnion, Todo, emptyModel } from './todoApp.js'

/** A stand-in for the live Foldkit Runtime: it records what would reach `update`. */
class TestHost {
  model: Model = emptyModel
  readonly dispatched: Array<Message> = []
  private readonly listeners = new Set<() => void>()

  readonly host = {
    model: () => this.model,
    dispatch: (message: Message) => {
      this.dispatched.push(message)
    },
    principal: () => this.principal,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    },
  }

  principal: unknown = { canDelete: true }

  setModel(model: Model): void {
    this.model = model
    for (const listener of this.listeners) listener()
  }
}

const invocation = (transport = 'webmcp') => ({
  id: 'invocation-1',
  transport,
})

const AppAgent = Agent.define({
  context: Agent.context({
    schema: Schema.Struct({ todos: Schema.Array(Todo) }),
    select: (model: Model) => ({ todos: model.todos }),
  }),

  messages: Agent.expose(MessageUnion, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },

    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: (model: Model) => Option.isSome(model.selectedTodoId),
    },

    RequestedRenameTodo: {
      name: 'rename_todo',
      description: 'Rename a todo',
      input: Schema.Struct({ id: Schema.String }),
      toMessage: ({ id }) => ({ id, title: 'Renamed by agent' }),
      authorize: ({ principal }: { principal: unknown }) =>
        (principal as { canDelete: boolean }).canDelete,
    },
  }),

  resources: [
    Agent.resource('todos', {
      description: 'Current todos',
      schema: Schema.Array(Todo),
      read: (model: Model) => model.todos,
    }),
  ],
})

let host: TestHost
let runtime: ReturnType<typeof makeRuntime>

const makeRuntime = (h: TestHost) => Agent.bind({ definition: AppAgent, host: h.host })

beforeEach(() => {
  host = new TestHost()
  runtime = makeRuntime(host)
})

/** Runs an Effect and returns its failure, so tests can assert on the error tag. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>): { readonly _tag: string } => {
  const result = Effect.runSync(Effect.result(effect))
  if (result._tag !== 'Failure') {
    throw new Error(`Expected a failure, got success: ${JSON.stringify(result)}`)
  }
  return result.failure as { readonly _tag: string }
}

describe('AgentRuntime.messages.dispatch', () => {
  it('dispatches a Message into the Runtime', () => {
    const result = Effect.runSync(
      runtime.messages.dispatch('create_todo', { title: 'Write docs' }, invocation()),
    )

    expect(result.tag).toBe('RequestedCreateTodo')
    expect(host.dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('rejects an unknown capability', () => {
    const failure = failureOf(runtime.messages.dispatchUnknown('drop_database', {}, invocation()))
    expect(failure._tag).toBe('AgentUnknownCapabilityError')
    expect(host.dispatched).toEqual([])
  })

  it('rejects input that fails the Schema boundary', () => {
    const failure = failureOf(
      runtime.messages.dispatchUnknown('create_todo', { title: 42 }, invocation()),
    )
    expect(failure._tag).toBe('AgentInvalidInputError')
    expect(host.dispatched).toEqual([])
  })

  it('refuses a capability whose availability predicate is false', () => {
    const failure = failureOf(runtime.messages.dispatch('delete_todo', { id: 'a' }, invocation()))
    expect(failure._tag).toBe('AgentCapabilityUnavailableError')
    expect(host.dispatched).toEqual([])
  })

  it('allows the same capability once the Model makes it available', () => {
    host.setModel({ ...emptyModel, selectedTodoId: Option.some('a') })

    const result = Effect.runSync(runtime.messages.dispatch('delete_todo', { id: 'a' }, invocation()))
    expect(result.tag).toBe('RequestedDeleteTodo')
    expect(host.dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'a' }])
  })

  it('maps external input onto the internal Message', () => {
    Effect.runSync(runtime.messages.dispatch('rename_todo', { id: 'a' }, invocation()))

    expect(host.dispatched).toEqual([
      { _tag: 'RequestedRenameTodo', id: 'a', title: 'Renamed by agent' },
    ])
  })

  it('never dispatches a denied call', () => {
    host.principal = { canDelete: false }

    const failure = failureOf(runtime.messages.dispatch('rename_todo', { id: 'a' }, invocation()))
    expect(failure._tag).toBe('AgentAuthorizationError')
    expect(host.dispatched).toEqual([])
  })

  it('supports an Effect-returning authorize hook', () => {
    const definition = Agent.define({
      messages: Agent.expose(MessageUnion, {
        RequestedCreateTodo: {
          name: 'create_todo',
          description: 'Create a todo',
          authorize: () => Effect.succeed(false),
        },
      }),
    })
    const bound = Agent.bind({ definition, host: host.host })

    const failure = failureOf(bound.messages.dispatch('create_todo', { title: 'x' }, invocation()))
    expect(failure._tag).toBe('AgentAuthorizationError')
  })

  it('carries the invocation through to the result', () => {
    const result = Effect.runSync(
      runtime.messages.dispatch('create_todo', { title: 'x' }, invocation('mcp')),
    )
    expect(result.invocation).toMatchObject({ id: 'invocation-1', transport: 'mcp' })
  })
})

describe('AgentRuntime projections', () => {
  it('reads the projected context from the live Model', () => {
    const todo = { id: 'a', title: 'A', completed: false }
    host.setModel({ ...emptyModel, todos: [todo] })

    expect(Effect.runSync(runtime.context)).toEqual({ todos: [todo] })
  })

  it('reads a named resource', () => {
    const todo = { id: 'a', title: 'A', completed: false }
    host.setModel({ ...emptyModel, todos: [todo] })

    expect(Effect.runSync(runtime.resources.read('todos'))).toEqual([todo])
  })

  it('fails for an unknown resource', () => {
    const failure = failureOf(runtime.resources.read('secrets'))
    expect(failure._tag).toBe('AgentResourceError')
  })

  it('lists every capability, and only available ones on demand', () => {
    expect(Effect.runSync(runtime.messages.list).map(m => m.name)).toEqual([
      'create_todo',
      'delete_todo',
      'rename_todo',
    ])
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toEqual([
      'create_todo',
      'rename_todo',
    ])

    host.setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toEqual([
      'create_todo',
      'delete_todo',
      'rename_todo',
    ])
  })

  it('notifies subscribers when the Model changes', () => {
    let calls = 0
    const unsubscribe = runtime.subscribe(() => {
      calls += 1
    })

    host.setModel({ ...emptyModel, todos: [] })
    expect(calls).toBe(1)

    unsubscribe()
    host.setModel(emptyModel)
    expect(calls).toBe(1)
  })
})
