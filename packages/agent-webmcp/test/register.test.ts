import { Agent } from '@foldkit/agent'
import { Effect, Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentWebMcp } from '../src/index.js'
import type { ModelContext, RegisterToolOptions, ToolDescriptor } from '../src/webmcp.js'

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  ReceivedTodos: { todos: Schema.Array(Todo) },
})

type Message = typeof Message.Type

interface Model {
  readonly todos: ReadonlyArray<typeof Todo.Type>
  readonly selectedTodoId: Option.Option<string>
}

const emptyModel: Model = { todos: [], selectedTodoId: Option.none() }

const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})

/**
 * Stands in for `document.modelContext`.
 *
 * It records the registration signal from the second argument, where the
 * documented API takes it, so a test cannot pass by agreeing with the adapter
 * about the wrong shape.
 */
class FakeModelContext implements ModelContext {
  readonly tools: Array<{ tool: ToolDescriptor; signal: AbortSignal | undefined }> = []
  /** Names the browser refuses to register, as one may. */
  readonly failing = new Set<string>()

  registerTool = (tool: ToolDescriptor, options?: RegisterToolOptions): void => {
    if (this.failing.has(tool.name)) {
      throw new Error(`registerTool refused ${tool.name}`)
    }
    this.tools.push({ tool, signal: options?.signal })
  }

  /** The tools that have not had their registration signal aborted. */
  live(): ReadonlyArray<ToolDescriptor> {
    return this.tools.filter(entry => entry.signal?.aborted !== true).map(entry => entry.tool)
  }

  signalFor(name: string): AbortSignal | undefined {
    return this.tools.find(entry => entry.tool.name === name)?.signal
  }

  find(name: string): ToolDescriptor {
    const tool = this.live().find(candidate => candidate.name === name)
    if (tool === undefined) throw new Error(`No live tool named ${name}`)
    return tool
  }
}

let model: Model
let dispatched: Array<Message>
let listeners: Set<() => void>
let modelContext: FakeModelContext

const setModel = (next: Model): void => {
  model = next
  for (const listener of listeners) listener()
}

const makeRuntime = () =>
  TodoAgent.bind({
    definition: AppAgent,
    host: {
      model: () => model,
      dispatch: (message: Message) => {
        dispatched.push(message)
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  })

beforeEach(() => {
  model = emptyModel
  dispatched = []
  listeners = new Set()
  modelContext = new FakeModelContext()
})

describe('AgentWebMcp.register', () => {
  it('registers one tool per available capability', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    expect(modelContext.live().map(tool => tool.name)).toEqual(['create_todo'])
    expect(registration.registered()).toEqual(['create_todo'])
  })

  it('derives the tool description and input schema from the contract', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    const tool = modelContext.find('create_todo')
    expect(tool.description).toBe('Create a todo')
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    })
  })

  it('dispatches into the Runtime when a tool executes', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    const result = await modelContext.find('create_todo').execute({ title: 'Write docs' }, {})

    expect(result.isError).toBeFalsy()
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('reports invalid input as a tool error without dispatching', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    const result = await modelContext.find('create_todo').execute({ title: 42 }, {})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/Invalid input/)
    expect(dispatched).toEqual([])
  })

  it('follows the Model: a capability appears when it becomes available', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()
    expect(registration.registered()).toEqual(['create_todo'])

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await registration.refresh()

    expect(registration.registered()).toEqual(['create_todo', 'delete_todo'])
    expect(modelContext.live().map(tool => tool.name)).toEqual(['create_todo', 'delete_todo'])
  })

  it('unregisters a capability by aborting its registration signal', async () => {
    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()
    expect(registration.registered()).toContain('delete_todo')

    setModel(emptyModel)
    await registration.refresh()

    expect(registration.registered()).toEqual(['create_todo'])
    expect(modelContext.signalFor('delete_todo')?.aborted).toBe(true)
  })

  it('registers each capability only once across refreshes', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()
    await registration.refresh()
    await registration.refresh()

    expect(modelContext.tools.filter(entry => entry.tool.name === 'create_todo')).toHaveLength(1)
  })

  it('passes the execution signal through to the invocation', async () => {
    const runtime = makeRuntime()
    const seen: Array<AbortSignal | undefined> = []
    const observed = {
      ...runtime,
      messages: {
        ...runtime.messages,
        dispatchUnknown: (name: string, input: unknown, invocation: any) => {
          seen.push(invocation.signal)
          return runtime.messages.dispatchUnknown(name, input, invocation)
        },
      },
    }

    const registration = AgentWebMcp.register({ agent: observed as never, modelContext })
    await registration.refresh()

    const controller = new AbortController()
    await modelContext.find('create_todo').execute({ title: 'x' }, { signal: controller.signal })

    expect(seen).toEqual([controller.signal])
  })

  it('reconciles automatically when the Model changes', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    // The subscription reconciles on its own; wait for the microtask queue.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(registration.registered()).toEqual(['create_todo', 'delete_todo'])
  })

  it('stops following the Model after unregister', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()
    expect(listeners.size).toBe(1)

    registration.unregister()

    expect(registration.registered()).toEqual([])
    expect(modelContext.live()).toEqual([])
    // The subscription itself must be released, not merely ignored.
    expect(listeners.size).toBe(0)

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registration.registered()).toEqual([])
  })

  it('does not subscribe when followModel is false', async () => {
    const registration = AgentWebMcp.register({
      agent: makeRuntime(),
      modelContext,
      followModel: false,
    })
    await registration.refresh()

    expect(listeners.size).toBe(0)

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Without followModel, availability changes only apply on an explicit refresh.
    expect(registration.registered()).toEqual(['create_todo'])

    await registration.refresh()
    expect(registration.registered()).toEqual(['create_todo', 'delete_todo'])
  })

  it('unregisters when the registration signal aborts', async () => {
    const controller = new AbortController()
    const registration = AgentWebMcp.register({
      agent: makeRuntime(),
      modelContext,
      signal: controller.signal,
    })
    await registration.refresh()
    expect(registration.registered()).toEqual(['create_todo'])

    controller.abort()

    expect(registration.registered()).toEqual([])
  })

  it('registers nothing when the signal is already aborted', async () => {
    const registration = AgentWebMcp.register({
      agent: makeRuntime(),
      modelContext,
      signal: AbortSignal.abort(),
    })
    await registration.refresh()

    expect(registration.registered()).toEqual([])
    expect(modelContext.live()).toEqual([])
  })

  it('reports a defect as a tool error instead of rejecting', async () => {
    const runtime = TodoAgent.bind({
      definition: AppAgent,
      host: {
        model: () => model,
        dispatch: () => {
          throw new Error('the Runtime exploded')
        },
      },
    })

    const registration = AgentWebMcp.register({ agent: runtime, modelContext })
    await registration.refresh()

    const result = await modelContext.find('create_todo').execute({ title: 'x' }, {})

    expect(result.isError).toBe(true)
    // The failure is reported without leaking the underlying error.
    expect(result.content[0]?.text).toBe('Capability "create_todo" failed unexpectedly')
    expect(result.content[0]?.text).not.toMatch(/exploded/)
  })

  it('reports a background reconcile failure through onError', async () => {
    const errors: Array<unknown> = []
    const runtime = TodoAgent.bind({
      definition: AppAgent,
      host: {
        model: () => {
          throw new Error('Model unavailable')
        },
        dispatch: () => {},
      },
    })

    AgentWebMcp.register({
      agent: runtime,
      modelContext,
      onError: error => errors.push(error),
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/Model unavailable/)
  })

  it('never exposes an unexposed Message', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    expect(modelContext.tools.map(entry => entry.tool.name)).not.toContain('received_todos')
  })

  it('explains itself when the page provides no modelContext', () => {
    expect(() => AgentWebMcp.register({ agent: makeRuntime() })).toThrow(/no document.modelContext/)
  })
})

describe('AgentWebMcp end to end', () => {
  /**
   * The adapter, the contract, and the Runtime together: a capability that is
   * both Model-dependent and authorized, reached through a registered tool.
   */
  it('carries an authorization denial through to the tool caller', async () => {
    let allowed = false
    const definition = TodoAgent.define({
      messages: TodoAgent.expose(Message, {
        RequestedDeleteTodo: {
          name: 'delete_todo',
          description: 'Delete the selected todo',
          available: model => Option.isSome(model.selectedTodoId),
          authorize: () => allowed,
        },
      }),
    })

    model = { ...emptyModel, selectedTodoId: Option.some('a') }
    const runtime = TodoAgent.bind({
      definition,
      host: { model: () => model, dispatch: (message: Message) => void dispatched.push(message) },
    })

    const registration = AgentWebMcp.register({ agent: runtime, modelContext })
    await registration.refresh()

    const denied = await modelContext.find('delete_todo').execute({ id: 'a' }, {})
    expect(denied.isError).toBe(true)
    expect(denied.content[0]?.text).toMatch(/Not authorized/)
    expect(dispatched).toEqual([])

    allowed = true
    const permitted = await modelContext.find('delete_todo').execute({ id: 'a' }, {})
    expect(permitted.isError).toBeFalsy()
    expect(dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'a' }])
  })

  it('registers the external schema and dispatches the mapped Message', async () => {
    const definition = TodoAgent.define({
      messages: TodoAgent.expose(Message, {
        RequestedCreateTodo: {
          name: 'create_todo',
          description: 'Create a todo',
          input: Schema.Struct({ title: Schema.String }),
          toMessage: ({ title }, { invocation }) => ({ title: `${title} (${invocation.id})` }),
        },
      }),
    })

    const runtime = TodoAgent.bind({
      definition,
      host: { model: () => model, dispatch: (message: Message) => void dispatched.push(message) },
    })

    const registration = AgentWebMcp.register({
      agent: runtime,
      modelContext,
      invocationId: () => 'fixed-id',
    })
    await registration.refresh()

    const tool = modelContext.find('create_todo')
    expect(tool.inputSchema).toMatchObject({ required: ['title'] })

    await tool.execute({ title: 'Write docs' }, {})
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs (fixed-id)' }])
  })

  it('rejects a field the registered schema does not advertise', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    // The registered inputSchema says additionalProperties: false.
    const result = await modelContext
      .find('create_todo')
      .execute({ title: 'x', completed: true }, {})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/Invalid input/)
    expect(dispatched).toEqual([])
  })
})

describe('registration lifecycle, against the documented API', () => {
  it('passes the registration signal where registerTool takes it', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()

    // Not on the descriptor: aborting the options signal is what unregisters.
    expect(modelContext.signalFor('create_todo')).toBeInstanceOf(AbortSignal)
    expect(modelContext.find('create_todo')).not.toHaveProperty('signal')

    registration.unregister()
    expect(modelContext.signalFor('create_todo')?.aborted).toBe(true)
  })

  it('does not register a tool after disposal', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let entered: () => void = () => {}
    const hasEntered = new Promise<void>(resolve => {
      entered = resolve
    })

    const runtime = TodoAgent.bind({
      definition: AppAgent,
      host: { model: () => model, dispatch: (_: Message) => {} },
    })

    // Reading availability blocks, so unregister lands while a reconcile is
    // already past its first disposal check.
    let reads = 0
    const slow = {
      ...runtime,
      messages: {
        ...runtime.messages,
        available: Effect.promise(async () => {
          reads += 1
          entered()
          await blocked
          return Effect.runSync(runtime.messages.available)
        }),
      },
    }

    const registration = AgentWebMcp.register({ agent: slow as never, modelContext })
    await hasEntered

    registration.unregister()
    release()
    await registration.refresh()

    expect(reads).toBe(1)
    expect(modelContext.live()).toEqual([])
    expect(registration.registered()).toEqual([])
  })

  it('does not record a registration the browser refused', async () => {
    modelContext.failing.add('create_todo')

    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })

    await expect(registration.refresh()).rejects.toThrow(/refused create_todo/)
    expect(registration.registered()).toEqual([])
  })

  it('registers the rest when one registration is refused', async () => {
    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    modelContext.failing.add('create_todo')

    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh().catch(() => {})

    expect(registration.registered()).toEqual(['delete_todo'])
  })

  it('retries a refused registration on the next reconcile', async () => {
    modelContext.failing.add('create_todo')
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh().catch(() => {})
    expect(registration.registered()).toEqual([])

    modelContext.failing.clear()
    await registration.refresh()
    expect(registration.registered()).toEqual(['create_todo'])
  })

  it('registers each capability once when reconciles overlap', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })

    await Promise.all([registration.refresh(), registration.refresh(), registration.refresh()])

    expect(modelContext.tools.filter(entry => entry.tool.name === 'create_todo')).toHaveLength(1)
  })
})

describe('disposal races', () => {
  /** A modelContext whose registrations can be held open. */
  class BlockingModelContext extends FakeModelContext {
    private release: (() => void) | undefined
    readonly registering: Promise<void>
    private entered: () => void = () => {}

    constructor() {
      super()
      this.registering = new Promise<void>(resolve => {
        this.entered = resolve
      })
    }

    override registerTool = async (
      tool: ToolDescriptor,
      options?: RegisterToolOptions,
    ): Promise<void> => {
      this.tools.push({ tool, signal: options?.signal })
      this.entered()
      await new Promise<void>(resolve => {
        this.release = resolve
      })
    }

    finish(): void {
      this.release?.()
    }
  }

  it('attempts no registration once disposed', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let entered: () => void = () => {}
    const hasEntered = new Promise<void>(resolve => {
      entered = resolve
    })

    const runtime = makeRuntime()
    const slow = {
      ...runtime,
      messages: {
        ...runtime.messages,
        available: Effect.promise(async () => {
          entered()
          await blocked
          return Effect.runSync(runtime.messages.available)
        }),
      },
    }

    const registration = AgentWebMcp.register({ agent: slow as never, modelContext })
    await hasEntered
    registration.unregister()
    release()
    await registration.refresh()

    // Not merely aborted afterwards: never handed to the browser at all.
    expect(modelContext.tools).toEqual([])
  })

  it('takes back a tool that was registered while disposal landed', async () => {
    const blocking = new BlockingModelContext()
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext: blocking })

    await blocking.registering
    registration.unregister()
    blocking.finish()
    await registration.refresh()

    // The browser accepted it, so it has to be aborted rather than forgotten.
    expect(blocking.tools).toHaveLength(1)
    expect(blocking.signalFor('create_todo')?.aborted).toBe(true)
    expect(blocking.live()).toEqual([])
    expect(registration.registered()).toEqual([])
  })
})
