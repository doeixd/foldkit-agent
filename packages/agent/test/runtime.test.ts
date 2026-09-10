import { Cause, Effect, Option, Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import {
  type Message,
  type Model,
  Message as MessageUnion,
  Todo,
  emptyModel,
  modelWith,
} from './todoApp.js'

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

/** Runs an Effect and returns the `Error` defect it died with. */
const defectOf = (effect: Effect.Effect<unknown, unknown>): Error => {
  const exit = Effect.runSyncExit(effect)
  if (exit._tag !== 'Failure') {
    throw new Error(`Expected a defect, got success: ${JSON.stringify(exit)}`)
  }
  const defect = Cause.squash(exit.cause)
  if (!(defect instanceof Error)) {
    throw new Error(`Expected an Error defect, got: ${String(defect)}`)
  }
  return defect
}

/** A contract whose projections return values their declared schemas reject. */
const lyingRuntime = Agent.bind({
  definition: Agent.define({
    context: Agent.context({
      schema: Schema.Struct({ userId: Schema.String }),
      select: (): { userId: string } => ({ userId: 4242 }) as unknown as { userId: string },
    }),
    messages: Agent.expose(MessageUnion, {}),
    resources: [
      Agent.resource('profile', {
        description: 'The signed-in profile',
        schema: Schema.Struct({ userId: Schema.String }),
        read: (): { userId: string } => ({ userId: 4242 }) as unknown as { userId: string },
      }),
    ],
  }),
  host: { model: () => ({}), dispatch: () => {} },
})

/**
 * A contract whose schemas transform, so the value served can only be the
 * encoded side that adapters put on the wire.
 */
const encodedRuntime = Agent.bind({
  definition: Agent.define({
    context: Agent.context({
      schema: Schema.Struct({ count: Schema.FiniteFromString }),
      select: () => ({ count: 2, secret: 'do not serve me' }),
    }),
    messages: Agent.expose(MessageUnion, {}),
    resources: [
      Agent.resource('count', {
        description: 'A count',
        schema: Schema.Struct({ count: Schema.FiniteFromString }),
        read: () => ({ count: 2 }),
      }),
    ],
  }),
  host: { model: () => ({}), dispatch: () => {} },
})

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

  // Availability is one guarantee with two halves: an unavailable capability is
  // neither advertised nor invocable. Knowing the name is not enough to call it.
  it('withholds an unavailable capability from discovery and from dispatch', () => {
    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).not.toContain('delete_todo')

    const failure = failureOf(runtime.messages.dispatch('delete_todo', { id: 'a' }, invocation()))
    expect(failure._tag).toBe('AgentCapabilityUnavailableError')
    expect(host.dispatched).toEqual([])
  })

  it('reports an unavailable capability without inspecting its input', () => {
    // Availability is checked before decoding, so a caller learns the
    // capability is not on offer rather than what its payload should have
    // looked like. Reversing the two would answer a malformed payload with a
    // schema complaint, telling an unauthorized caller the capability exists.
    const failure = failureOf(
      runtime.messages.dispatchUnknown('delete_todo', { nonsense: true }, invocation()),
    )

    expect(failure._tag).toBe('AgentCapabilityUnavailableError')
    expect(host.dispatched).toEqual([])
  })

  it('offers the same capability to both once the Model makes it available', () => {
    host.setModel({ ...emptyModel, selectedTodoId: Option.some('a') })

    expect(Effect.runSync(runtime.messages.available).map(m => m.name)).toContain('delete_todo')

    const result = Effect.runSync(
      runtime.messages.dispatch('delete_todo', { id: 'a' }, invocation()),
    )
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

  it('gives each execution of a reused Effect its own default invocation id', () => {
    const operation = runtime.messages.dispatch('create_todo', { title: 'x' })

    const first = Effect.runSync(operation)
    const second = Effect.runSync(operation)

    expect(host.dispatched).toHaveLength(2)
    expect(second.invocation.id).not.toEqual(first.invocation.id)
  })

  it('keeps a caller-supplied invocation id stable across executions', () => {
    const operation = runtime.messages.dispatch('create_todo', { title: 'x' }, invocation())

    const first = Effect.runSync(operation)
    const second = Effect.runSync(operation)

    expect(first.invocation.id).toEqual('invocation-1')
    expect(second.invocation.id).toEqual('invocation-1')
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

  it('serves the context and a resource as their encoded wire representation', () => {
    expect(Effect.runSync(encodedRuntime.context)).toEqual({ count: '2' })
    expect(Effect.runSync(encodedRuntime.resources.read('count'))).toEqual({ count: '2' })
  })

  it('drops properties the context schema does not declare', () => {
    expect(Effect.runSync(encodedRuntime.context)).not.toHaveProperty('secret')
  })

  it('refuses to serve a context projection that violates its schema', () => {
    const defect = defectOf(lyingRuntime.context)

    expect(defect.name).toBe('AgentProjectionError')
    expect(defect.message).toBe('The context projection does not match its declared schema')
  })

  it('refuses to serve a resource whose read violates its schema', () => {
    const defect = defectOf(lyingRuntime.resources.read('profile'))

    expect(defect.name).toBe('AgentProjectionError')
    expect(defect.message).toBe(
      'The resource "profile" projection does not match its declared schema',
    )
  })

  it('reports a violating projection as a defect, not as a caller-facing failure', () => {
    const exit = Effect.runSyncExit(lyingRuntime.resources.read('profile'))

    expect(exit._tag).toBe('Failure')
    if (exit._tag !== 'Failure') return
    expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true)
  })

  it('does not leak the offending value or the schema issue in the defect message', () => {
    const defect = defectOf(lyingRuntime.resources.read('profile'))

    expect(defect.message).not.toContain('4242')
    expect(defect.message).not.toContain('Expected')
  })

  it('lists the whole contract, including what the Model does not currently offer', () => {
    expect(Effect.runSync(runtime.messages.list).map(m => m.name)).toEqual([
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

describe('cancellation', () => {
  const cancellingAgent = (authorize: () => Effect.Effect<boolean>) => {
    const dispatched: Array<Message> = []
    const runtime = Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, {
          RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo', authorize },
        }),
      }),
      host: {
        model: () => emptyModel,
        dispatch: (message: Message) => void dispatched.push(message),
      },
    })
    return { runtime, dispatched }
  }

  it('refuses an invocation whose signal is already aborted', () => {
    const { runtime, dispatched } = cancellingAgent(() => Effect.succeed(true))

    const failure = failureOf(
      runtime.messages.dispatch(
        'create_todo',
        { title: 'x' },
        {
          id: 'i',
          transport: 'webmcp',
          signal: AbortSignal.abort(),
        },
      ),
    )

    expect(failure._tag).toBe('AgentCancelledError')
    expect(dispatched).toEqual([])
  })

  it('does not dispatch when the caller aborts while authorization is pending', async () => {
    let approve: (allowed: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => {
      approve = resolve
    })
    const { runtime, dispatched } = cancellingAgent(() => Effect.promise(() => pending))

    const controller = new AbortController()
    const running = Effect.runPromise(
      Effect.result(
        runtime.messages.dispatch(
          'create_todo',
          { title: 'x' },
          {
            id: 'i',
            transport: 'webmcp',
            signal: controller.signal,
          },
        ),
      ),
    )

    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    approve(true)
    const result = await running

    expect(result._tag).toBe('Failure')
    expect((result as { failure: { _tag: string } }).failure._tag).toBe('AgentCancelledError')
    expect(dispatched).toEqual([])
  })

  it('dispatches normally when the signal is never aborted', async () => {
    const { runtime, dispatched } = cancellingAgent(() => Effect.succeed(true))

    await Effect.runPromise(
      runtime.messages.dispatch(
        'create_todo',
        { title: 'x' },
        {
          id: 'i',
          transport: 'webmcp',
          signal: new AbortController().signal,
        },
      ),
    )

    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'x' }])
  })
})

describe('an already-cancelled invocation', () => {
  it('touches neither the Model nor the authorization hook', () => {
    let modelReads = 0
    let authorizeCalls = 0

    const runtime = Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, {
          RequestedCreateTodo: {
            name: 'create_todo',
            description: 'Create a todo',
            authorize: () => {
              authorizeCalls += 1
              return true
            },
          },
        }),
      }),
      host: {
        model: () => {
          modelReads += 1
          return emptyModel
        },
        dispatch: (_: Message) => {},
      },
    })

    const failure = failureOf(
      runtime.messages.dispatch(
        'create_todo',
        { title: 'x' },
        {
          id: 'i',
          transport: 'webmcp',
          signal: AbortSignal.abort(),
        },
      ),
    )

    expect(failure._tag).toBe('AgentCancelledError')
    // Refused before any of the work an invocation would otherwise cause.
    expect(modelReads).toBe(0)
    expect(authorizeCalls).toBe(0)
  })
})

describe('the Model snapshot', () => {
  /**
   * `delete_selected_todo` reads `selectedTodoId` twice -- once in `available`
   * and once in `toMessage` -- so the invocation is only coherent if both see
   * the same Model. The `getOrThrow` is the same one `examples/todo` relies on.
   */
  const snapshotAgent = (authorize: () => Effect.Effect<boolean>) => {
    let model = modelWith({ selectedTodoId: Option.some('A') })
    let modelReads = 0
    const dispatched: Array<Message> = []

    const runtime = Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, {
          RequestedDeleteTodo: {
            name: 'delete_selected_todo',
            description: 'Delete the selected todo',
            available: (m: Model) => Option.isSome(m.selectedTodoId),
            input: Schema.Struct({}),
            toMessage: (_: object, context: { model: Model }) => ({
              id: Option.getOrThrow(context.model.selectedTodoId),
            }),
            authorize,
          },
        }),
      }),
      host: {
        model: () => {
          modelReads += 1
          return model
        },
        dispatch: (message: Message) => void dispatched.push(message),
      },
    })

    return {
      runtime,
      dispatched,
      setModel: (next: Model) => {
        model = next
      },
      modelReads: () => modelReads,
    }
  }

  it('constructs the Message from the Model captured at dispatch, not the live one', async () => {
    let approve: (allowed: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => {
      approve = resolve
    })
    const agent = snapshotAgent(() => Effect.promise(() => pending))

    const running = Effect.runPromise(
      agent.runtime.messages.dispatch('delete_selected_todo', {}, invocation()),
    )

    await new Promise(resolve => setTimeout(resolve, 0))
    agent.setModel(modelWith({ selectedTodoId: Option.some('B') }))
    approve(true)
    await running

    expect(agent.dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'A' }])
  })

  it('reads the Model once per invocation', () => {
    const agent = snapshotAgent(() => Effect.succeed(true))

    Effect.runSync(agent.runtime.messages.dispatch('delete_selected_todo', {}, invocation()))

    expect(agent.modelReads()).toBe(1)
  })
})
