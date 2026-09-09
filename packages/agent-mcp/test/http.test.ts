import { Agent } from '@foldkit/agent'
import { AgentMcp, type HttpRequest, type HttpResponse, type SseEvent } from '@foldkit/agent-mcp'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
})

type Message = typeof Message.Type

interface Model {
  readonly selectedTodoId: Option.Option<string>
}

interface Principal {
  readonly user: string
}

const TodoAgent = Agent.forModel<Model, Principal>()

const definition = TodoAgent.define({
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})

let model: Model
let listeners: Set<() => void>
/** Which principal each created session was bound to. */
let boundTo: Array<Principal>
let dispatched: Array<{ principal: string; message: Message }>

const setModel = (next: Model): void => {
  model = next
  for (const listener of [...listeners]) listener()
}

const makeServer = (
  overrides: Partial<
    Parameters<typeof AgentMcp.httpHandler<Model, unknown, Principal, any, any>>[0]
  > = {},
) =>
  AgentMcp.httpHandler<Model, unknown, Principal, any, any>({
    createAgent: ({ principal }) => {
      boundTo.push(principal)
      return TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) =>
            void dispatched.push({ principal: principal.user, message }),
          principal: () => principal,
          subscribe: listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      })
    },
    authenticate: (request: HttpRequest) => {
      const token = request.headers['authorization']
      return token === undefined ? undefined : { user: token.replace('Bearer ', '') }
    },
    allowedOrigins: ['https://app.example'],
    ...overrides,
  })

const post = (body: unknown, headers: Record<string, string | undefined> = {}): HttpRequest => ({
  method: 'POST',
  headers: { authorization: 'Bearer alice', ...headers },
  body,
})

const initialize = { jsonrpc: '2.0' as const, id: 1, method: 'initialize' }

const sessionOf = (response: HttpResponse): string => {
  const id = response.headers['mcp-session-id']
  if (id === undefined) throw new Error('No session id was issued')
  return id
}

beforeEach(() => {
  model = { selectedTodoId: Option.none() }
  listeners = new Set()
  boundTo = []
  dispatched = []
})

describe('sessions', () => {
  it('issues a session id on initialize', async () => {
    const server = makeServer()
    const response = await server.handle(post(initialize))

    expect(response.status).toBe(200)
    expect(sessionOf(response)).toMatch(/^[!-~]+$/)
    expect(server.sessions()).toHaveLength(1)
  })

  it('issues a different id each time', async () => {
    const server = makeServer()
    const first = sessionOf(await server.handle(post(initialize)))
    const second = sessionOf(await server.handle(post(initialize)))

    expect(first).not.toBe(second)
  })

  it('answers a request carrying its session id', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )

    expect((response.body as { result: { tools: Array<unknown> } }).result.tools).toHaveLength(1)
  })

  it('answers 404 for an unknown session, so the client re-initializes', async () => {
    const server = makeServer()
    await server.handle(post(initialize))

    const response = await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'made-up' }),
    )

    expect(response.status).toBe(404)
  })

  it('refuses anything but initialize without a session', async () => {
    const server = makeServer()
    const response = await server.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))

    expect(response.status).toBe(400)
  })

  it('terminates a session on DELETE', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const deleted = await server.handle({
      method: 'DELETE',
      headers: { authorization: 'Bearer alice', 'mcp-session-id': id },
    })

    expect(deleted.status).toBe(204)
    expect(server.sessions()).toEqual([])
  })

  it('drops a session that has gone idle', async () => {
    const server = makeServer({ sessionTtlMs: -1 })
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': id }),
    )

    expect(response.status).toBe(404)
  })

  it('drops idle sessions when a new one initializes', async () => {
    const server = makeServer({ sessionTtlMs: -1 })
    const first = sessionOf(await server.handle(post(initialize)))
    const second = sessionOf(await server.handle(post(initialize)))

    expect(server.sessions()).toEqual([second])
    expect(first).not.toBe(second)
  })

  it('closes the handler of a session expired by a new initialize', async () => {
    const server = makeServer({ sessionTtlMs: -1 })
    await server.handle(post(initialize))
    expect(listeners.size).toBe(1)

    await server.handle(post(initialize))

    expect(listeners.size).toBe(1)
  })

  it('answers 202 for a notification, which has no reply', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await server.handle(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': id }),
    )

    expect(response.status).toBe(202)
    expect(response.body).toBeUndefined()
  })
})

describe('security', () => {
  it('refuses an Origin that is not allowed', async () => {
    const server = makeServer()
    const response = await server.handle(post(initialize, { origin: 'https://evil.example' }))

    expect(response.status).toBe(403)
    expect(server.sessions()).toEqual([])
  })

  it('accepts an allowed Origin', async () => {
    const server = makeServer()
    const response = await server.handle(post(initialize, { origin: 'https://app.example' }))

    expect(response.status).toBe(200)
  })

  it('refuses every Origin when none are configured', async () => {
    // A DNS-rebinding attack arrives with an Origin, so the default is to say no.
    const server = makeServer({ allowedOrigins: undefined })
    const response = await server.handle(post(initialize, { origin: 'https://app.example' }))

    expect(response.status).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    const server = makeServer()
    const response = await server.handle(post(initialize, { authorization: undefined }))

    expect(response.status).toBe(401)
    expect(server.sessions()).toEqual([])
  })

  it('binds each session to the caller the transport authenticated', async () => {
    const server = makeServer()
    await server.handle(post(initialize, { authorization: 'Bearer alice' }))
    await server.handle(post(initialize, { authorization: 'Bearer bob' }))

    expect(boundTo).toEqual([{ user: 'alice' }, { user: 'bob' }])
  })

  it('ignores a principal a caller tries to supply in params', async () => {
    // Taking a principal from request params would let anyone claim any identity.
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize, { authorization: 'Bearer alice' })))

    await server.handle(
      post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_todo',
            arguments: { title: 'x' },
            principal: { user: 'root' },
          },
        },
        { 'mcp-session-id': id },
      ),
    )

    expect(dispatched).toEqual([
      { principal: 'alice', message: { _tag: 'RequestedCreateTodo', title: 'x' } },
    ])
  })

  it('never lets two principals share a runtime', async () => {
    const server = makeServer()
    const alice = sessionOf(
      await server.handle(post(initialize, { authorization: 'Bearer alice' })),
    )
    const bob = sessionOf(await server.handle(post(initialize, { authorization: 'Bearer bob' })))

    const call = (session: string, title: string) =>
      server.handle(
        post(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'create_todo', arguments: { title } },
          },
          { 'mcp-session-id': session },
        ),
      )

    await call(alice, 'from alice')
    await call(bob, 'from bob')

    expect(dispatched.map(entry => entry.principal)).toEqual(['alice', 'bob'])
  })
})

describe('protocol version', () => {
  it('accepts the negotiated version', async () => {
    const server = makeServer()
    const response = await server.handle(
      post(initialize, { 'mcp-protocol-version': AgentMcp.PROTOCOL_VERSION }),
    )

    expect(response.status).toBe(200)
  })

  it('assumes the pre-header release when the header is absent', async () => {
    const server = makeServer()
    expect((await server.handle(post(initialize))).status).toBe(200)
  })

  it('refuses a version it does not speak', async () => {
    const server = makeServer()
    const response = await server.handle(post(initialize, { 'mcp-protocol-version': '1999-01-01' }))

    expect(response.status).toBe(400)
  })
})

describe('the SSE stream', () => {
  const open = async (server: ReturnType<typeof makeServer>, id: string, lastEventId?: string) =>
    server.handle({
      method: 'GET',
      headers: {
        authorization: 'Bearer alice',
        'mcp-session-id': id,
        ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
      },
    })

  it('is opened by GET on a known session', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await open(server, id)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect(response.stream).toBeDefined()
  })

  it('refuses GET without a known session', async () => {
    const server = makeServer()
    expect((await open(server, 'made-up')).status).toBe(404)
  })

  it('carries a notification when the advertised set changes', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))
    await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )

    const events: Array<SseEvent> = []
    ;(await open(server, id)).stream?.subscribe(event => events.push(event))

    setModel({ selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0]!.data)).toMatchObject({
      method: 'notifications/tools/list_changed',
    })
  })

  it('sends each event to one stream, never both', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))
    await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )

    const first: Array<SseEvent> = []
    const second: Array<SseEvent> = []
    ;(await open(server, id)).stream?.subscribe(event => first.push(event))
    ;(await open(server, id)).stream?.subscribe(event => second.push(event))

    setModel({ selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(first.length + second.length).toBe(1)
  })

  it('replays what a resuming client missed, and nothing it already saw', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))
    await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )

    const seen: Array<SseEvent> = []
    const unsubscribe = (await open(server, id)).stream?.subscribe(event => seen.push(event))

    setModel({ selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))
    unsubscribe?.()

    // Disconnected here, then two more changes it never saw.
    setModel({ selectedTodoId: Option.none() })
    setModel({ selectedTodoId: Option.some('b') })
    await new Promise(resolve => setTimeout(resolve, 0))

    const resumed = await open(server, id, seen[0]!.id)

    expect(resumed.stream?.backlog.map(event => event.id)).toEqual(['2', '3'])
  })

  it('replays nothing for a client that is not resuming', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    expect((await open(server, id)).stream?.backlog).toEqual([])
  })
})

describe('other methods', () => {
  it('rejects a method the transport does not define', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await server.handle({
      method: 'PUT',
      headers: { authorization: 'Bearer alice', 'mcp-session-id': id },
    })

    expect(response.status).toBe(405)
  })

  it('closes every session it holds', async () => {
    const server = makeServer()
    await server.handle(post(initialize))
    await server.handle(post(initialize))

    server.close()

    expect(server.sessions()).toEqual([])
    expect(listeners.size).toBe(0)
  })
})
