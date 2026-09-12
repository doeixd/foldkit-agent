import { Agent } from 'foldkit-agent'
import { AgentMcp } from 'foldkit-agent-mcp'
import { Option, Schema } from 'effect'
import * as HttpEffect from 'effect/unstable/http/HttpEffect'
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

const definition = TodoAgent.make({
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
let dispatched: Array<{ principal: string; message: Message }>

const setModel = (next: Model): void => {
  model = next
  for (const listener of [...listeners]) listener()
}

/** The whole thing behind a plain web handler, as an application would run it. */
const makeWebHandler = () => {
  const server = AgentMcp.httpHandler<Model, unknown, Principal, any, any>({
    createAgent: ({ principal }) =>
      TodoAgent.bind({
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
      }),
    authenticate: request => {
      const token = request.headers['authorization']
      return token === undefined ? undefined : { user: token.replace('Bearer ', '') }
    },
    allowedOrigins: ['https://app.example'],
  })

  return HttpEffect.toWebHandler(
    AgentMcp.httpApp<Model, unknown, Principal, any, any>({ server } as never),
  )
}

const url = 'http://localhost/mcp'

const send = (
  handler: ReturnType<typeof makeWebHandler>,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  handler(
    new Request(url, {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )

const initialize = { jsonrpc: '2.0' as const, id: 1, method: 'initialize' }

beforeEach(() => {
  model = { selectedTodoId: Option.none() }
  listeners = new Set()
  dispatched = []
})

describe('as a web handler', () => {
  it('answers initialize with a session id header', async () => {
    const handler = makeWebHandler()
    const response = await send(handler, initialize)

    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toMatch(/^[!-~]+$/)
    expect((await response.json()).result.protocolVersion).toBe(AgentMcp.PROTOCOL_VERSION)
  })

  it('carries a session across requests', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!

    const listed = await send(
      handler,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session },
    )

    expect((await listed.json()).result.tools).toHaveLength(1)
  })

  it('dispatches a tool call through to the Runtime', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!

    await send(
      handler,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_todo', arguments: { title: 'Write docs' } },
      },
      { 'mcp-session-id': session },
    )

    expect(dispatched).toEqual([
      { principal: 'alice', message: { _tag: 'RequestedCreateTodo', title: 'Write docs' } },
    ])
  })

  it('refuses a disallowed Origin before creating a session', async () => {
    const handler = makeWebHandler()
    const response = await send(handler, initialize, { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  it('refuses an unauthenticated caller', async () => {
    const handler = makeWebHandler()
    const response = await handler(
      new Request(url, { method: 'POST', body: JSON.stringify(initialize) }),
    )

    expect(response.status).toBe(401)
  })

  it('answers 404 for an unknown session', async () => {
    const handler = makeWebHandler()
    const response = await send(
      handler,
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { 'mcp-session-id': 'made-up' },
    )

    expect(response.status).toBe(404)
  })

  it('answers 202 with no body for a notification', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!

    const response = await send(
      handler,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': session },
    )

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('terminates a session on DELETE', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!

    const deleted = await handler(
      new Request(url, {
        method: 'DELETE',
        headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
      }),
    )

    expect(deleted.status).toBe(204)
  })

  it('answers a body that is not JSON with a parse error', async () => {
    const handler = makeWebHandler()
    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
        body: 'not json',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32700 } })
  })

  it('answers valid JSON that is not a JSON-RPC message with an invalid request error', async () => {
    const handler = makeWebHandler()
    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'there' }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ id: null, error: { code: -32600 } })
  })
})

describe('the SSE stream, over the wire', () => {
  it('streams a notification as a framed event', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!
    await send(
      handler,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session },
    )

    const response = await handler(
      new Request(url, {
        method: 'GET',
        headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
      }),
    )

    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    // The stream subscribes on the first read, so start reading before the
    // Model changes: a notification emitted with nobody listening is dropped.
    const pending = reader.read()
    await new Promise(resolve => setTimeout(resolve, 10))
    setModel({ selectedTodoId: Option.some('a') })

    const { value } = await pending
    const frame = new TextDecoder().decode(value)

    // id: and data: are what a client resumes from and parses.
    expect(frame).toMatch(/^id: \d+\ndata: /)
    expect(JSON.parse(frame.split('data: ')[1]!)).toMatchObject({
      method: 'notifications/tools/list_changed',
    })
    await reader.cancel()
  })

  it('replays what a reconnecting client missed', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!
    await send(
      handler,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session },
    )

    // Change while nobody is listening.
    setModel({ selectedTodoId: Option.some('a') })
    await new Promise(resolve => setTimeout(resolve, 0))

    const resumed = await handler(
      new Request(url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer alice',
          'mcp-session-id': session,
          'last-event-id': '0',
        },
      }),
    )

    const reader = resumed.body!.getReader()
    const { value } = await reader.read()

    expect(new TextDecoder().decode(value)).toMatch(/^id: 1\ndata: /)
    await reader.cancel()
  })
})

describe('a terminated session', () => {
  it('completes the open SSE response instead of leaving it hanging', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!

    const response = await handler(
      new Request(url, {
        method: 'GET',
        headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
      }),
    )

    const reader = response.body!.getReader()
    const pending = reader.read()
    await new Promise(resolve => setTimeout(resolve, 10))

    await handler(
      new Request(url, {
        method: 'DELETE',
        headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
      }),
    )

    const closed = await Promise.race([
      pending.then(result => result.done),
      new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
    ])

    expect(closed).toBe(true)
  })
})

describe('a disconnected stream', () => {
  it('is released, so the next event reaches a live one', async () => {
    const handler = makeWebHandler()
    const session = (await send(handler, initialize)).headers.get('mcp-session-id')!
    await send(
      handler,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session },
    )

    const open = async () => {
      const response = await handler(
        new Request(url, {
          method: 'GET',
          headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
        }),
      )
      const reader = response.body!.getReader()
      const first = reader.read()
      await new Promise(resolve => setTimeout(resolve, 10))
      return { reader, first }
    }

    const older = await open()
    const newer = await open()

    // The newest stream goes away, as a reconnecting client's does.
    await newer.reader.cancel()
    await new Promise(resolve => setTimeout(resolve, 10))

    setModel({ selectedTodoId: Option.some('a') })

    // If the closed stream were still subscribed it would be the newest, and
    // this event would go to a reader nobody is holding.
    const { value } = await older.first
    expect(new TextDecoder().decode(value)).toMatch(/list_changed/)
    await older.reader.cancel()
  })
})
