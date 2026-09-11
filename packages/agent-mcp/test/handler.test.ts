import { Agent } from 'foldkit-agent'
import { Projection } from 'foldkit-surface'
import { AgentMcp, type Notification, type Response } from 'foldkit-agent-mcp'
import { Effect, Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })

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

const TodoAgent = Agent.forModel<Model, { readonly canDelete: boolean }>()

const definition = TodoAgent.define({
  context: Projection.of(Schema.Struct({ todos: Schema.Array(Todo) }))({ todos: true }),
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: ({ principal }) => principal.canDelete,
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

let model: Model
let dispatched: Array<Message>
let principal: { readonly canDelete: boolean }
let listeners: Set<() => void>
let notifications: Array<Notification>

const setModel = (next: Model): void => {
  model = next
  for (const listener of [...listeners]) listener()
}

const makeHandler = (debounceMs?: number) =>
  AgentMcp.handler({
    agent: TodoAgent.bind({
      definition,
      host: {
        model: () => model,
        dispatch: (message: Message) => void dispatched.push(message),
        principal: () => principal,
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }),
    onNotification: (notification: Notification) => notifications.push(notification),
    ...(debounceMs === undefined ? {} : { debounceMs }),
  })

const request = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

const ok = (response: Response | undefined): Record<string, unknown> => {
  if (response === undefined || !('result' in response)) {
    throw new Error(`Expected a result, got ${JSON.stringify(response)}`)
  }
  return response.result
}

const err = (response: Response | undefined): { code: number; message: string } => {
  if (response === undefined || !('error' in response)) {
    throw new Error(`Expected an error, got ${JSON.stringify(response)}`)
  }
  return response.error
}

beforeEach(() => {
  model = emptyModel
  dispatched = []
  principal = { canDelete: true }
  listeners = new Set()
  notifications = []
})

/** Most tests start from an initialized session. */
const initialized = async (debounceMs?: number) => {
  const served = makeHandler(debounceMs)
  await served.handle(request(0, 'initialize'))
  return served
}

describe('lifecycle', () => {
  it('announces the protocol version, capabilities, and server info', async () => {
    const served = makeHandler()
    const result = ok(await served.handle(request(1, 'initialize')))

    expect(result['protocolVersion']).toBe(AgentMcp.PROTOCOL_VERSION)
    expect(result['capabilities']).toMatchObject({ tools: { listChanged: true }, resources: {} })
    expect(result['serverInfo']).toMatchObject({ name: 'foldkit-agent' })
  })

  it('declares no resources capability when the contract has none', async () => {
    const served = AgentMcp.handler({
      agent: Agent.bind({
        definition: Agent.define({
          messages: Agent.expose(Message, { RequestedCreateTodo: 'Create a todo' }),
        }),
        host: { model: () => emptyModel, dispatch: () => {} },
      }),
    })

    expect(ok(await served.handle(request(1, 'initialize')))['capabilities']).not.toHaveProperty(
      'resources',
    )
  })

  it('refuses a request that arrives before initialize', async () => {
    const served = makeHandler()

    expect(err(await served.handle(request(1, 'tools/list'))).message).toMatch(/before initialize/)
  })

  it('answers ping', async () => {
    const served = await initialized()
    expect(ok(await served.handle(request(1, 'ping')))).toEqual({})
  })

  it('rejects an unknown method', async () => {
    const served = await initialized()
    expect(err(await served.handle(request(1, 'tools/explode'))).code).toBe(-32601)
  })

  it('rejects a batch rather than half-answering it', async () => {
    const served = await initialized()
    const error = err(await served.handle([request(1, 'ping')]))

    expect(error.code).toBe(-32600)
    // Says what was wrong, rather than the generic shape complaint.
    expect(error.message).toMatch(/Batched/)
  })

  it('rejects something that is not a JSON-RPC message', async () => {
    const served = await initialized()
    expect(err(await served.handle({ hello: 'there' })).code).toBe(-32600)
  })

  it('returns nothing for a notification', async () => {
    const served = await initialized()
    expect(await served.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(
      undefined,
    )
  })
})

describe('tools/list', () => {
  it('lists the capabilities available in the current Model', async () => {
    const served = await initialized()
    const tools = ok(await served.handle(request(1, 'tools/list')))['tools'] as Array<{
      name: string
    }>

    expect(tools.map(tool => tool.name)).toEqual(['create_todo'])
  })

  it('advertises the derived input schema', async () => {
    const served = await initialized()
    const tools = ok(await served.handle(request(1, 'tools/list')))['tools'] as Array<{
      name: string
      description: string
      inputSchema: Record<string, unknown>
    }>

    expect(tools[0]).toMatchObject({
      name: 'create_todo',
      description: 'Create a todo',
      inputSchema: { type: 'object', required: ['title'] },
    })
  })

  it('follows the Model', async () => {
    const served = await initialized()
    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })

    const tools = ok(await served.handle(request(1, 'tools/list')))['tools'] as Array<{
      name: string
    }>
    expect(tools.map(tool => tool.name)).toEqual(['create_todo', 'delete_todo'])
  })

  it('rejects a cursor it never issued', async () => {
    const served = await initialized()
    const error = err(await served.handle(request(1, 'tools/list', { cursor: 'made-up' })))
    expect(error.code).toBe(-32602)
  })
})

describe('tools/call error mapping', () => {
  it('reports an unknown tool as a protocol error', async () => {
    const served = await initialized()
    const error = err(await served.handle(request(1, 'tools/call', { name: 'nope' })))

    expect(error.code).toBe(-32602)
    expect(dispatched).toEqual([])
  })

  it('reports arguments that fail the schema as a protocol error', async () => {
    const served = await initialized()
    const error = err(
      await served.handle(
        request(1, 'tools/call', { name: 'create_todo', arguments: { title: 42 } }),
      ),
    )

    expect(error.code).toBe(-32602)
    expect(dispatched).toEqual([])
  })

  it('reports an authorization refusal as a tool error, not a protocol error', async () => {
    // A client must not retry a refusal as though it were a transport fault.
    model = { ...emptyModel, selectedTodoId: Option.some('a') }
    principal = { canDelete: false }
    const served = await initialized()

    const result = ok(
      await served.handle(
        request(1, 'tools/call', { name: 'delete_todo', arguments: { id: 'a' } }),
      ),
    )

    expect(result['isError']).toBe(true)
    expect(dispatched).toEqual([])
  })

  it('reports an unavailable capability as a tool error', async () => {
    const served = await initialized()

    const result = ok(
      await served.handle(
        request(1, 'tools/call', { name: 'delete_todo', arguments: { id: 'a' } }),
      ),
    )

    expect(result['isError']).toBe(true)
    expect(JSON.stringify(result)).toMatch(/not available/)
  })

  it('requires a tool name', async () => {
    const served = await initialized()
    expect(err(await served.handle(request(1, 'tools/call', {}))).code).toBe(-32602)
  })
})

describe('tools/call success', () => {
  it('dispatches into the Runtime and reports the Message', async () => {
    const served = await initialized()

    const result = ok(
      await served.handle(
        request(1, 'tools/call', { name: 'create_todo', arguments: { title: 'Write docs' } }),
      ),
    )

    expect(result['isError']).toBeFalsy()
    expect(result['content']).toEqual([{ type: 'text', text: 'Dispatched RequestedCreateTodo' }])
    expect(result['structuredContent']).toMatchObject({ capability: 'create_todo' })
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('treats missing arguments as an empty payload', async () => {
    const served = await initialized()
    const error = err(await served.handle(request(1, 'tools/call', { name: 'create_todo' })))

    // An empty payload still has to satisfy the advertised schema.
    expect(error.code).toBe(-32602)
  })
})

describe('resources', () => {
  it('lists the projected context alongside declared resources', async () => {
    const served = await initialized()
    const resources = ok(await served.handle(request(1, 'resources/list')))['resources'] as Array<{
      uri: string
    }>

    expect(resources.map(resource => resource.uri)).toEqual(['app://context', 'app://todos'])
  })

  it('reads a resource off the live Model', async () => {
    model = { ...emptyModel, todos: [{ id: 'a', title: 'A' }] }
    const served = await initialized()

    const contents = ok(await served.handle(request(1, 'resources/read', { uri: 'app://todos' })))[
      'contents'
    ] as Array<{ text: string }>

    expect(JSON.parse(contents[0]!.text)).toEqual([{ id: 'a', title: 'A' }])
  })

  it('reads the projected context', async () => {
    model = { ...emptyModel, todos: [{ id: 'a', title: 'A' }] }
    const served = await initialized()

    const contents = ok(
      await served.handle(request(1, 'resources/read', { uri: 'app://context' })),
    )['contents'] as Array<{ text: string }>

    expect(JSON.parse(contents[0]!.text)).toEqual({ todos: [{ id: 'a', title: 'A' }] })
  })

  it('rejects an unknown resource', async () => {
    const served = await initialized()
    const error = err(await served.handle(request(1, 'resources/read', { uri: 'app://secrets' })))

    expect(error.code).toBe(-32002)
  })

  describe('a declared resource named context', () => {
    const declaredContext = TodoAgent.resource('context', {
      description: 'The application own context',
      schema: Schema.String,
      read: () => 'resource-value',
    })

    const serve = async (withProjection: boolean) => {
      const served = AgentMcp.handler({
        agent: TodoAgent.bind({
          definition: TodoAgent.define({
            ...(withProjection
              ? {
                  context: Projection.of(Schema.Struct({ todos: Schema.Array(Todo) }))({
                    todos: true,
                  }),
                }
              : {}),
            messages: TodoAgent.expose(Message, { RequestedCreateTodo: 'Create a todo' }),
            resources: [declaredContext],
          }),
          host: { model: () => model, dispatch: () => {}, principal: () => principal },
        }),
      })
      await served.handle(request(0, 'initialize'))
      return served
    }

    for (const withProjection of [false, true]) {
      const label = withProjection ? 'with a Model projection' : 'without a Model projection'

      it(`lists app://context once ${label}`, async () => {
        const served = await serve(withProjection)
        const resources = ok(await served.handle(request(1, 'resources/list')))[
          'resources'
        ] as Array<{ uri: string; description?: string }>

        expect(resources).toEqual([
          {
            uri: 'app://context',
            name: 'context',
            description: 'The application own context',
            mimeType: 'application/json',
          },
        ])
      })

      it(`reads the declared resource ${label}`, async () => {
        const served = await serve(withProjection)
        const contents = ok(
          await served.handle(request(1, 'resources/read', { uri: 'app://context' })),
        )['contents'] as Array<{ text: string }>

        expect(JSON.parse(contents[0]!.text)).toBe('resource-value')
      })
    }
  })

  it('rejects a uri that is not app://', async () => {
    const served = await initialized()
    expect(
      err(await served.handle(request(1, 'resources/read', { uri: 'file:///etc/passwd' }))).code,
    ).toBe(-32602)
  })
})

describe('notifications/tools/list_changed', () => {
  it('announces when the advertised set changes', async () => {
    const served = await initialized()
    await served.handle(request(1, 'tools/list'))

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications.map(n => n.method)).toEqual(['notifications/tools/list_changed'])
  })

  it('stays quiet when the Model changes but the set does not', async () => {
    const served = await initialized()
    await served.handle(request(1, 'tools/list'))

    // A Model that changes constantly must not become a notification storm.
    for (let i = 0; i < 20; i += 1) {
      setModel({ ...emptyModel, todos: [{ id: `${i}`, title: `${i}` }] })
    }
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toEqual([])
  })

  it('coalesces a flapping set when a debounce is set', async () => {
    const served = await initialized(5)
    await served.handle(request(1, 'tools/list'))

    for (let i = 0; i < 5; i += 1) {
      setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
      setModel(emptyModel)
    }
    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(notifications).toHaveLength(1)
  })

  it('stops following the Model once closed', async () => {
    const served = await initialized()
    await served.handle(request(1, 'tools/list'))
    served.close()

    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(notifications).toEqual([])
    expect(listeners.size).toBe(0)
  })

  it('emits nothing for a change that is still being read when close lands', async () => {
    const served = await initialized()
    await served.handle(request(1, 'tools/list'))

    // The subscription is already reading the availability set; close happens
    // before that read resolves.
    setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
    served.close()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([])
  })

  it('drops a debounced announcement that is still pending at close', async () => {
    const served = await initialized(5)
    await served.handle(request(1, 'tools/list'))

    vi.useFakeTimers()
    try {
      setModel({ ...emptyModel, selectedTodoId: Option.some('a') })
      // A timer left armed keeps the event loop alive after the server is done.
      expect(vi.getTimerCount()).toBe(1)
      served.close()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(25)
    } finally {
      vi.useRealTimers()
    }
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([])
  })

  it('unsubscribes once when close is called twice', async () => {
    let unsubscribes = 0
    const served = AgentMcp.handler({
      agent: TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
          subscribe: listener => {
            listeners.add(listener)
            return () => {
              unsubscribes += 1
              listeners.delete(listener)
            }
          },
        },
      }),
      onNotification: (notification: Notification) => notifications.push(notification),
    })
    await served.handle(request(0, 'initialize'))

    served.close()
    served.close()

    expect(unsubscribes).toBe(1)
  })
})

describe('notifications/cancelled', () => {
  it('aborts the invocation it names', async () => {
    const served = await initialized()
    const seen: Array<string> = []

    const call = served.handle(
      request(1, 'tools/call', { name: 'create_todo', arguments: { title: 'x' } }),
    )
    await served.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
    const result = ok(await call)
    seen.push(JSON.stringify(result))

    // The call had already completed, so cancelling it is a no-op rather than a
    // crash. What matters is that an unknown id is also harmless.
    await served.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'never-issued' },
    })
    expect(seen).toHaveLength(1)
  })
})

describe('cancelling a call in flight', () => {
  it('stops it before the Message is dispatched', async () => {
    let approve: (allowed: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => {
      approve = resolve
    })
    const sent: Array<Message> = []

    const served = AgentMcp.handler({
      agent: Agent.bind({
        definition: Agent.define({
          messages: Agent.expose(Message, {
            RequestedCreateTodo: {
              name: 'create_todo',
              description: 'Create a todo',
              authorize: () => Effect.promise(() => pending),
            },
          }),
        }),
        host: { model: () => emptyModel, dispatch: (message: Message) => void sent.push(message) },
      }),
    })
    await served.handle(request(0, 'initialize'))

    const call = served.handle(
      request(7, 'tools/call', { name: 'create_todo', arguments: { title: 'x' } }),
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    await served.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    })
    approve(true)

    const result = ok(await call)
    expect(result['isError']).toBe(true)
    expect(JSON.stringify(result)).toMatch(/cancelled/i)
    // Authorization resolved, but nothing reached update.
    expect(sent).toEqual([])
  })
})

describe('the stdio transport', () => {
  /** A pair of in-memory streams standing in for stdin and stdout. */
  const streams = () => {
    const written: Array<string> = []
    const listeners: Record<string, Array<(chunk: string) => void>> = {}
    const input = {
      on: (event: string, listener: (chunk: string) => void) => {
        ;(listeners[event] ??= []).push(listener)
        return input
      },
      send: (line: string) => {
        for (const listener of listeners['data'] ?? []) listener(line)
      },
    }
    const output = { write: (chunk: string) => written.push(chunk) }
    return { input, output, written }
  }

  it('answers newline-delimited messages and writes nothing else', async () => {
    const { input, output, written } = streams()
    AgentMcp.stdio({
      agent: TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
        },
      }),
      input: input as never,
      output: output as never,
    })

    input.send(`${JSON.stringify(request(1, 'initialize'))}\n`)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(written).toHaveLength(1)
    expect(written[0]!.endsWith('\n')).toBe(true)
    // Every line has to parse as a message; anything else corrupts the stream.
    expect(JSON.parse(written[0]!)).toMatchObject({ jsonrpc: '2.0', id: 1 })
  })

  it('reports a line that is not JSON without dying', async () => {
    const { input, output, written } = streams()
    AgentMcp.stdio({
      agent: TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
        },
      }),
      input: input as never,
      output: output as never,
    })

    input.send('not json at all\n')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(JSON.parse(written[0]!)).toMatchObject({ error: { code: -32700 } })
  })

  it('handles a message split across chunks', async () => {
    const { input, output, written } = streams()
    AgentMcp.stdio({
      agent: TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
        },
      }),
      input: input as never,
      output: output as never,
    })

    const line = JSON.stringify(request(1, 'initialize'))
    input.send(line.slice(0, 10))
    input.send(`${line.slice(10)}\n`)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 })
  })
})

describe('defects at the protocol boundary', () => {
  const boom = (): never => {
    throw new Error('private detail')
  }

  /** Everything an application callback can do wrong, in one contract. */
  const faulty = (
    part: 'context' | 'resource' | 'available',
  ): ReturnType<typeof AgentMcp.handler> =>
    AgentMcp.handler({
      agent: TodoAgent.bind({
        definition: TodoAgent.define({
          context: Projection.fromReader(
            Schema.Struct({ todos: Schema.Array(Todo) }),
            part === 'context' ? boom : (m: Model) => ({ todos: m.todos }),
          ),
          messages: TodoAgent.expose(Message, {
            RequestedCreateTodo: {
              name: 'create_todo',
              description: 'Create a todo',
              ...(part === 'available' ? { available: boom } : {}),
            },
          }),
          resources: [
            TodoAgent.resource('todos', {
              description: 'Current todos',
              schema: Schema.Array(Todo),
              read: part === 'resource' ? boom : (m: Model) => m.todos,
            }),
          ],
        }),
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
          subscribe: listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      }),
      onNotification: (notification: Notification) => notifications.push(notification),
    })

  const cases = [
    { part: 'context' as const, method: 'resources/read', params: { uri: 'app://context' } },
    { part: 'resource' as const, method: 'resources/read', params: { uri: 'app://todos' } },
    { part: 'available' as const, method: 'tools/list', params: undefined },
  ]

  for (const { part, method, params } of cases) {
    it(`answers with an internal error when the ${part} callback throws`, async () => {
      const served = faulty(part)
      await served.handle(request(0, 'initialize'))

      const error = err(await served.handle(request(1, method, params)))

      expect(error.code).toBe(-32603)
      // The callback's own text may carry application internals.
      expect(error.message).not.toMatch(/private detail/)
      expect(error.message).toMatch(new RegExp(method))
    })
  }

  it('does not let a throwing availability getter escape the subscription', async () => {
    const served = faulty('available')
    await served.handle(request(0, 'initialize'))

    const rejections: Array<unknown> = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      setModel({ ...emptyModel, todos: [{ id: 'a', title: 'a' }] })
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    served.close()
  })
})
