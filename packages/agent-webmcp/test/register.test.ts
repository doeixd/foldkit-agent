import { Agent } from '@foldkit/agent'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentWebMcp } from '../src/index.js'
import type { ModelContext, ToolDescriptor } from '../src/webmcp.js'

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

/** Records every registerTool call, standing in for `document.modelContext`. */
class FakeModelContext implements ModelContext {
  readonly tools: Array<ToolDescriptor> = []

  registerTool = (tool: ToolDescriptor): void => {
    this.tools.push(tool)
  }

  /** The tools that have not had their registration signal aborted. */
  live(): ReadonlyArray<ToolDescriptor> {
    return this.tools.filter(tool => tool.signal?.aborted !== true)
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
    const deleteTool = modelContext.tools.find(tool => tool.name === 'delete_todo')
    expect(deleteTool?.signal?.aborted).toBe(true)
  })

  it('registers each capability only once across refreshes', async () => {
    const registration = AgentWebMcp.register({ agent: makeRuntime(), modelContext })
    await registration.refresh()
    await registration.refresh()
    await registration.refresh()

    expect(modelContext.tools.filter(tool => tool.name === 'create_todo')).toHaveLength(1)
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

    expect(modelContext.tools.map(tool => tool.name)).not.toContain('received_todos')
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
    expect(dispatched).toEqual([
      { _tag: 'RequestedCreateTodo', title: 'Write docs (fixed-id)' },
    ])
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
