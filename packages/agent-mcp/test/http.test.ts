import { Agent } from '@foldkit/agent'
import { AgentMcp, type HttpRequest, type HttpResponse, type SseEvent } from '@foldkit/agent-mcp'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  headers: {
    authorization: 'Bearer alice',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  },
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

  describe('a session belongs to the principal that created it', () => {
    const createTodo = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'tools/call',
      params: { name: 'create_todo', arguments: { title: 'x' } },
    }

    const aliceSession = async (server: ReturnType<typeof makeServer>): Promise<string> =>
      sessionOf(await server.handle(post(initialize, { authorization: 'Bearer alice' })))

    it('refuses a POST from another principal, and dispatches nothing', async () => {
      const server = makeServer()
      const id = await aliceSession(server)

      const response = await server.handle(
        post(createTodo, { authorization: 'Bearer bob', 'mcp-session-id': id }),
      )

      // Indistinguishable from an unknown session, so the id's existence does
      // not leak and Bob's client re-initializes into a session of his own.
      expect(response.status).toBe(404)
      expect(dispatched).toEqual([])
    })

    it('refuses a GET and a DELETE from another principal', async () => {
      const server = makeServer()
      const id = await aliceSession(server)
      const headers = { authorization: 'Bearer bob', 'mcp-session-id': id }

      const stream = await server.handle({
        method: 'GET',
        headers: { ...headers, accept: 'text/event-stream' },
      })
      const removal = await server.handle({ method: 'DELETE', headers })

      expect(stream.status).toBe(404)
      expect(stream.stream).toBeUndefined()
      expect(removal.status).toBe(404)
      expect(server.sessions()).toEqual([id])
    })

    it('still answers its owner afterwards', async () => {
      const server = makeServer()
      const id = await aliceSession(server)
      await server.handle(post(createTodo, { authorization: 'Bearer bob', 'mcp-session-id': id }))

      const response = await server.handle(post(createTodo, { 'mcp-session-id': id }))

      expect(response.status).toBe(200)
      expect(dispatched).toEqual([
        { principal: 'alice', message: { _tag: 'RequestedCreateTodo', title: 'x' } },
      ])
    })

    it('uses principalId when the principal carries per-request fields', async () => {
      let issued = 0
      const server = makeServer({
        authenticate: (request: HttpRequest) => {
          const token = request.headers['authorization']
          return token === undefined
            ? undefined
            : { user: token.replace('Bearer ', ''), issuedAt: issued++ }
        },
        principalId: principal => principal.user,
      })
      const id = await aliceSession(server)

      const mine = await server.handle(post(createTodo, { 'mcp-session-id': id }))
      const theirs = await server.handle(
        post(createTodo, { authorization: 'Bearer bob', 'mcp-session-id': id }),
      )

      expect(mine.status).toBe(200)
      expect(theirs.status).toBe(404)
    })
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

    const call = (session: string, user: string, title: string) =>
      server.handle(
        post(
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'create_todo', arguments: { title } },
          },
          { authorization: `Bearer ${user}`, 'mcp-session-id': session },
        ),
      )

    await call(alice, 'alice', 'from alice')
    await call(bob, 'bob', 'from bob')

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

describe('media types', () => {
  const get = (accept: string | undefined, id: string): HttpRequest => ({
    method: 'GET',
    headers: { authorization: 'Bearer alice', 'mcp-session-id': id, accept },
  })

  it.each([
    ['text/plain', 'neither type'],
    ['application/json', 'no text/event-stream'],
    ['text/event-stream', 'no application/json'],
  ])('refuses a POST that accepts %s (%s)', async accept => {
    const server = makeServer()
    const response = await server.handle(post(initialize, { accept }))

    expect(response.status).toBe(406)
    expect(server.sessions()).toEqual([])
  })

  it.each([
    ['application/json, text/event-stream'],
    ['application/json;q=0.9, text/event-stream;q=0.8'],
    ['*/*'],
    [undefined],
  ])('answers a POST that accepts %s', async accept => {
    const server = makeServer()
    expect((await server.handle(post(initialize, { accept }))).status).toBe(200)
  })

  it.each([['text/plain'], ['application/x-www-form-urlencoded'], [undefined]])(
    'refuses a POST body typed %s',
    async contentType => {
      const server = makeServer()
      const response = await server.handle(post(initialize, { 'content-type': contentType }))

      expect(response.status).toBe(415)
      expect(server.sessions()).toEqual([])
    },
  )

  it('tolerates parameters on the content type', async () => {
    const server = makeServer()
    const response = await server.handle(
      post(initialize, { 'content-type': 'application/json; charset=utf-8' }),
    )

    expect(response.status).toBe(200)
  })

  it('refuses a GET that cannot take an event stream', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    const response = await server.handle(get('application/json', id))

    expect(response.status).toBe(406)
    expect(response.stream).toBeUndefined()
  })

  it.each([['text/event-stream'], ['text/*'], [undefined]])(
    'opens a GET that accepts %s',
    async accept => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))

      const response = await server.handle(get(accept, id))

      expect(response.status).toBe(200)
      expect(response.stream).toBeDefined()
    },
  )

  it('checks the media types before the session, so a bad GET never opens a stream', async () => {
    const server = makeServer()
    expect((await server.handle(get('text/plain', 'made-up'))).status).toBe(406)
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

  it('replays only the events of the stream that was interrupted', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))
    await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )
    const change = async (selectedTodoId: Option.Option<string>) => {
      setModel({ selectedTodoId })
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    const first: Array<SseEvent> = []
    const leaveFirst = (await open(server, id)).stream?.subscribe(event => first.push(event))
    await change(Option.some('a'))

    const second: Array<SseEvent> = []
    const leaveSecond = (await open(server, id)).stream?.subscribe(event => second.push(event))
    await change(Option.none())

    // One event on each, and event ids are unique across the whole session.
    expect([first.map(event => event.id), second.map(event => event.id)]).toEqual([['1'], ['2']])

    // Both transports drop, and a further change lands on the newest stream.
    leaveFirst?.()
    leaveSecond?.()
    await change(Option.some('b'))

    const resumedFirst = await open(server, id, '1')
    const resumedSecond = await open(server, id, '2')

    // Event 3 belongs to the second stream, so only it may be replayed there.
    expect(resumedFirst.stream?.backlog).toEqual([])
    expect(resumedSecond.stream?.backlog.map(event => event.id)).toEqual(['3'])
  })

  it('forgets the oldest disconnected stream once a session holds too many', async () => {
    const server = makeServer({ replayBuffer: 2 })
    const id = sessionOf(await server.handle(post(initialize)))
    await server.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': id }),
    )

    const seen: Array<SseEvent> = []
    const leave = (await open(server, id)).stream?.subscribe(event => seen.push(event))
    setModel({ selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))
    leave?.()
    setModel({ selectedTodoId: Option.none() })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect((await open(server, id, '1')).stream?.backlog.map(event => event.id)).toEqual(['2'])

    // Three further streams push the first past what the session will keep.
    for (const _ of [1, 2, 3]) await open(server, id)

    expect((await open(server, id, '1')).stream?.backlog).toEqual([])
  })

  it('replays nothing for a client that is not resuming', async () => {
    const server = makeServer()
    const id = sessionOf(await server.handle(post(initialize)))

    expect((await open(server, id)).stream?.backlog).toEqual([])
  })

  describe('ending when the session is terminated', () => {
    /**
     * Subscribes and reports whether the stream has been closed.
     *
     * The stream is asserted, not optional: a response that carries none means
     * the GET never opened one, and every `ended` assertion below would then
     * hold vacuously against a stream that does not exist.
     */
    const attach = (response: HttpResponse) => {
      const stream = response.stream
      if (stream === undefined) throw new Error('the GET opened no stream')
      const state = { ended: 0 }
      const unsubscribe = stream.subscribe(
        () => {},
        () => void state.ended++,
      )
      return { state, unsubscribe }
    }

    it('ends an open stream when the session is deleted', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      const { state } = attach(await open(server, id))

      expect(state.ended).toBe(0)
      await server.handle({
        method: 'DELETE',
        headers: { authorization: 'Bearer alice', 'mcp-session-id': id },
      })

      expect(state.ended).toBe(1)
    })

    it('ends an open stream when the session expires', async () => {
      // A real clock cannot express "idle later" without also making the session
      // expirable during setup, where the GET's own expiry pass would drop it
      // before the transport ever attached.
      vi.useFakeTimers()
      try {
        const server = makeServer({ sessionTtlMs: 1000 })
        const id = sessionOf(await server.handle(post(initialize)))
        const { state } = attach(await open(server, id))
        expect(state.ended).toBe(0)

        vi.setSystemTime(Date.now() + 5000)
        // Any later request runs expiry, which drops the now-idle session.
        await server.handle(post(initialize))

        expect(server.sessions()).not.toContain(id)
        expect(state.ended).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('ends an open stream when the server closes', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      const { state } = attach(await open(server, id))

      server.close()

      expect(state.ended).toBe(1)
    })

    it('ends both streams of a session that has two open', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      const first = attach(await open(server, id))
      const second = attach(await open(server, id))

      server.close()

      expect([first.state.ended, second.state.ended]).toEqual([1, 1])
    })

    it('leaves a stream that already ended alone', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      const { state, unsubscribe } = attach(await open(server, id))

      unsubscribe?.()
      server.close()

      expect(state.ended).toBe(0)
    })

    it('ends a stream subscribed after the session was already terminated', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      // Opened while the session was alive, attached to only after it went away.
      const response = await open(server, id)
      server.close()

      expect(attach(response).state.ended).toBe(1)
    })

    it('ends the remaining streams even when one transport throws', async () => {
      const server = makeServer()
      const id = sessionOf(await server.handle(post(initialize)))
      ;(await open(server, id)).stream?.subscribe(
        () => {},
        () => {
          throw new Error('transport is already gone')
        },
      )
      const { state } = attach(await open(server, id))

      expect(() => server.close()).not.toThrow()
      expect(state.ended).toBe(1)
      expect(server.sessions()).toEqual([])
    })
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
