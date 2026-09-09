import { Agent } from '@foldkit/agent'
import { AgentA2a } from '@foldkit/agent-a2a'
import type { Response, Task } from '@foldkit/agent-a2a'
import { Duration, Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  DeletedTodo: { id: Schema.String },
  FailedDeleteTodo: { id: Schema.String },
})

type Message = typeof Message.Type

interface Model {
  readonly selectedTodoId: Option.Option<string>
}

const emptyModel: Model = { selectedTodoId: Option.none() }

const TodoAgent = Agent.forModel<Model, { readonly canDelete: boolean }>()

let model: Model
let dispatched: Array<Message>
let principal: { readonly canDelete: boolean }
let emit: (message: Message) => void

const definition = TodoAgent.define({
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: ({ principal }) => principal.canDelete,
      completion: {
        success: Message.DeletedTodo,
        failure: Message.FailedDeleteTodo,
        timeout: Duration.millis(50),
      },
    },
  }),
})

let ids: number
const makeHandler = () => {
  const listeners = new Set<(message: Message) => void>()
  emit = message => {
    for (const listener of [...listeners]) listener(message)
  }

  return AgentA2a.handler({
    agent: TodoAgent.bind({
      definition,
      host: {
        model: () => model,
        dispatch: (message: Message) => void dispatched.push(message),
        principal: () => principal,
        observe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }),
    newId: () => `id-${ids++}`,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  })
}

/**
 * A second agent whose one skill waits for a completing Message that never
 * arrives on its own.
 *
 * Its timeout is far longer than the suite's, so a task of it settles only
 * because something settled it -- a test that merely waited the wait out would
 * time out instead of passing.
 */
const SlowMessage = defineMessageUnion({
  RequestedSlowTodo: { title: Schema.String },
  FinishedSlowTodo: { title: Schema.String },
})

const SlowAgent = Agent.forModel<Model, undefined>()

const slowDefinition = SlowAgent.define({
  messages: SlowAgent.expose(SlowMessage, {
    RequestedSlowTodo: {
      name: 'slow_todo',
      description: 'A todo that finishes much later',
      completion: { success: SlowMessage.FinishedSlowTodo, timeout: Duration.seconds(30) },
    },
  }),
})

let slowListeners: Set<(message: typeof SlowMessage.Type) => void>

const makeSlowHandler = () => {
  slowListeners = new Set()
  return AgentA2a.handler({
    agent: SlowAgent.bind({
      definition: slowDefinition,
      host: {
        model: () => model,
        dispatch: () => {},
        principal: () => undefined,
        observe: listener => {
          slowListeners.add(listener)
          return () => slowListeners.delete(listener)
        },
      },
    }),
    newId: () => `id-${ids++}`,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  })
}

const emitSlow = (message: typeof SlowMessage.Type) => {
  for (const listener of [...slowListeners]) listener(message)
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

const request = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
})

const sendSkill = (skill: string, input: unknown) =>
  request('message/send', {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'client-1',
      parts: [{ kind: 'data', data: { skill, input } }],
    },
  })

const task = (response: Response | undefined): Task => {
  if (response === undefined || !('result' in response)) {
    throw new Error(`Expected a task, got ${JSON.stringify(response)}`)
  }
  return response.result as Task
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
  ids = 0
})

describe('the Agent Card', () => {
  const card = () =>
    AgentA2a.agentCard(definition, {
      name: 'Todos',
      description: 'A todo list',
      url: 'https://todos.example/a2a',
    })

  it('lists one skill per exposed capability', () => {
    expect(card().skills.map(skill => skill.id)).toEqual(['create_todo', 'delete_todo'])
  })

  it('carries each skill’s derived input schema', () => {
    expect(card().skills[0]?.inputSchema).toMatchObject({ type: 'object', required: ['title'] })
  })

  it('tags a capability that only exists in some Model states', () => {
    // A card is static while availability is not, so a client is told.
    expect(card().skills.find(skill => skill.id === 'delete_todo')?.tags).toContain('conditional')
    expect(card().skills.find(skill => skill.id === 'create_todo')?.tags).toEqual([])
  })

  it('tags a capability that runs an authorization check', () => {
    expect(card().skills.find(skill => skill.id === 'delete_todo')?.tags).toContain('authorized')
  })

  it('does not claim capabilities it lacks', () => {
    expect(card().capabilities).toEqual({ streaming: false, pushNotifications: false })
  })

  it('carries the security schemes a client needs before calling', () => {
    const secured = AgentA2a.agentCard(definition, {
      name: 'Todos',
      description: 'A todo list',
      url: 'https://todos.example/a2a',
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    })

    expect(secured.securitySchemes).toMatchObject({ bearer: { type: 'http' } })
    expect(secured.security).toEqual([{ bearer: [] }])
  })

  it('is served from the well-known path', () => {
    expect(AgentA2a.AGENT_CARD_PATH).toBe('/.well-known/agent-card.json')
  })
})

describe('message/send', () => {
  it('dispatches the named skill and completes the task', async () => {
    const served = makeHandler()
    const result = task(await served.handle(sendSkill('create_todo', { title: 'Write docs' })))

    expect(result.status.state).toBe('completed')
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('keeps the client’s message in the task history', async () => {
    const served = makeHandler()
    const result = task(await served.handle(sendSkill('create_todo', { title: 'x' })))

    expect(result.history).toMatchObject([{ role: 'user', messageId: 'client-1' }])
  })

  it('rejects an unknown skill', async () => {
    const served = makeHandler()
    const result = task(await served.handle(sendSkill('nope', {})))

    expect(result.status.state).toBe('rejected')
    expect(dispatched).toEqual([])
  })

  it('rejects input that fails the skill’s schema', async () => {
    const served = makeHandler()
    const result = task(await served.handle(sendSkill('create_todo', { title: 42 })))

    expect(result.status.state).toBe('rejected')
  })

  it('rejects a caller who may not', async () => {
    model = { selectedTodoId: Option.some('a') }
    principal = { canDelete: false }
    const served = makeHandler()

    const result = task(await served.handle(sendSkill('delete_todo', { id: 'a' })))

    // Declined outright, which is a different thing to work that failed.
    expect(result.status.state).toBe('rejected')
    expect(dispatched).toEqual([])
  })

  it('needs a data part naming a skill', async () => {
    const served = makeHandler()
    const response = await served.handle(
      request('message/send', {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'client-1',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      }),
    )

    expect(err(response).code).toBe(-32602)
  })

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['no params at all', undefined],
    ['params that are not an object', 'message/send'],
    ['no message', {}],
    ['a message that is not an object', { message: 'create a todo' }],
    [
      'a message with no parts',
      { message: { kind: 'message', role: 'user', messageId: 'client-1' } },
    ],
    [
      'parts that are not an array',
      { message: { kind: 'message', role: 'user', messageId: 'client-1', parts: {} } },
    ],
    [
      'a null part',
      { message: { kind: 'message', role: 'user', messageId: 'client-1', parts: [null] } },
    ],
    [
      'a data part with no data',
      {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'client-1',
          parts: [{ kind: 'data' }],
        },
      },
    ],
    [
      'a data part whose data is not an object',
      {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'client-1',
          parts: [{ kind: 'data', data: null }],
        },
      },
    ],
    [
      'no messageId',
      {
        message: {
          kind: 'message',
          role: 'user',
          parts: [{ kind: 'data', data: { skill: 'create_todo', input: { title: 'x' } } }],
        },
      },
    ],
    [
      'no role',
      {
        message: {
          kind: 'message',
          messageId: 'client-1',
          parts: [{ kind: 'data', data: { skill: 'create_todo', input: { title: 'x' } } }],
        },
      },
    ],
    [
      'no kind, which the spec requires so Task and Message stay distinguishable',
      {
        message: {
          role: 'user',
          messageId: 'client-1',
          parts: [{ kind: 'data', data: { skill: 'create_todo', input: { title: 'x' } } }],
        },
      },
    ],
    [
      'a role this protocol has no meaning for',
      {
        message: {
          kind: 'message',
          role: 'system',
          messageId: 'client-1',
          parts: [{ kind: 'data', data: { skill: 'create_todo', input: { title: 'x' } } }],
        },
      },
    ],
  ]

  it.each(malformed)('answers invalid-params for %s', async (_, params) => {
    const served = makeHandler()
    const response = await served.handle(request('message/send', params as never))

    expect(err(response).code).toBe(-32602)
    // A request that never validated must not reach the host.
    expect(dispatched).toEqual([])
  })

  it('does not leak the reason a malformed message was refused', async () => {
    const served = makeHandler()
    const response = await served.handle(
      request('message/send', { message: { parts: [null] } } as never),
    )

    expect(err(response).message).not.toMatch(/parts\[0\]|SchemaError|Union/)
  })

  it('carries the client’s context id when given one', async () => {
    const served = makeHandler()
    const result = task(
      await served.handle(
        request('message/send', {
          message: {
            kind: 'message',
            role: 'user',
            messageId: 'client-1',
            contextId: 'conversation-7',
            parts: [{ kind: 'data', data: { skill: 'create_todo', input: { title: 'x' } } }],
          },
        }),
      ),
    )

    expect(result.contextId).toBe('conversation-7')
  })
})

describe('a skill that declares completion', () => {
  it('completes when its success Message arrives', async () => {
    model = { selectedTodoId: Option.some('a') }
    const served = makeHandler()

    const pending = served.handle(sendSkill('delete_todo', { id: 'a' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    emit(Message.DeletedTodo({ id: 'a' }))

    expect(task(await pending).status.state).toBe('completed')
  })

  it('fails when its failure Message arrives', async () => {
    model = { selectedTodoId: Option.some('a') }
    const served = makeHandler()

    const pending = served.handle(sendSkill('delete_todo', { id: 'a' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    emit(Message.FailedDeleteTodo({ id: 'a' }))

    // Accepted and did not succeed, which is not the same as rejected.
    expect(task(await pending).status.state).toBe('failed')
  })

  it('fails, rather than rejects, when nothing completes it', async () => {
    model = { selectedTodoId: Option.some('a') }
    const served = makeHandler()

    const result = task(await served.handle(sendSkill('delete_todo', { id: 'a' })))

    expect(result.status.state).toBe('failed')
    // The Message reached update; only the waiting stopped.
    expect(dispatched).toHaveLength(1)
  })
})

describe('tasks', () => {
  it('can be fetched after the fact', async () => {
    const served = makeHandler()
    const created = task(await served.handle(sendSkill('create_todo', { title: 'x' })))

    const fetched = task(await served.handle(request('tasks/get', { id: created.id })))

    expect(fetched.id).toBe(created.id)
    expect(fetched.status.state).toBe('completed')
  })

  it('report not-found for an id this agent never issued', async () => {
    const served = makeHandler()
    expect(err(await served.handle(request('tasks/get', { id: 'made-up' }))).code).toBe(-32001)
  })

  it('refuse to cancel a task that already settled', async () => {
    const served = makeHandler()
    const created = task(await served.handle(sendSkill('create_todo', { title: 'x' })))

    // The spec has a code for this; answering `completed` to a cancel does not.
    expect(err(await served.handle(request('tasks/cancel', { id: created.id }))).code).toBe(-32002)
    expect(task(await served.handle(request('tasks/get', { id: created.id }))).status.state).toBe(
      'completed',
    )
  })

  it('are addressable while they are still running', async () => {
    const served = makeSlowHandler()
    const pending = served.handle(sendSkill('slow_todo', { title: 'x' }))
    await settled()

    const inFlight = task(await served.handle(request('tasks/get', { id: 'id-0' })))

    expect(inFlight.status.state).toBe('working')
    expect(inFlight.history).toMatchObject([{ messageId: 'client-1' }])

    emitSlow(SlowMessage.FinishedSlowTodo({ title: 'x' }))
    expect(task(await pending).status.state).toBe('completed')
  })

  it('stay canceled once canceled, and a later completion does not undo it', async () => {
    const served = makeSlowHandler()
    const pending = served.handle(
      request('message/send', {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'client-1',
          contextId: 'original',
          parts: [{ kind: 'data', data: { skill: 'slow_todo', input: { title: 'x' } } }],
        },
      }),
    )
    await settled()

    const cancelled = task(await served.handle(request('tasks/cancel', { id: 'id-0' })))

    expect(cancelled.status.state).toBe('canceled')
    // The identity the task was started with, not a freshly invented one.
    expect(cancelled.contextId).toBe('original')
    expect(cancelled.history).toMatchObject([{ messageId: 'client-1' }])

    // Resolving at all means the wait was settled rather than waited out.
    expect(await pending).toMatchObject({ result: { status: { state: 'canceled' } } })
    expect(slowListeners.size).toBe(0)

    emitSlow(SlowMessage.FinishedSlowTodo({ title: 'x' }))
    expect(task(await served.handle(request('tasks/get', { id: 'id-0' }))).status.state).toBe(
      'canceled',
    )
  })

  it('are bounded, dropping the oldest', async () => {
    const served = AgentA2a.handler({
      agent: TodoAgent.bind({
        definition,
        host: {
          model: () => model,
          dispatch: (message: Message) => void dispatched.push(message),
          principal: () => principal,
          observe: () => () => {},
        },
      }),
      capacity: 2,
      newId: () => `id-${ids++}`,
    })

    const first = task(await served.handle(sendSkill('create_todo', { title: 'a' })))
    await served.handle(sendSkill('create_todo', { title: 'b' }))
    await served.handle(sendSkill('create_todo', { title: 'c' }))

    expect(err(await served.handle(request('tasks/get', { id: first.id }))).code).toBe(-32001)
  })
})

describe('the envelope', () => {
  it('rejects an unknown method', async () => {
    const served = makeHandler()
    expect(err(await served.handle(request('agent/explode'))).code).toBe(-32601)
  })

  it('refuses streaming rather than pretending', async () => {
    // The card says streaming: false, so answering here would contradict it.
    const served = makeHandler()
    const error = err(await served.handle(request('message/stream')))

    expect(error.code).toBe(-32601)
    // Says why, rather than looking like a typo in the method name.
    expect(error.message).toMatch(/does not support streaming/)
  })

  it('rejects a batch', async () => {
    const served = makeHandler()
    expect(err(await served.handle([request('tasks/get')])).message).toMatch(/Batched/)
  })

  it('rejects something that is not JSON-RPC', async () => {
    const served = makeHandler()
    expect(err(await served.handle({ hello: 'there' })).code).toBe(-32600)
  })

  it('returns nothing for a notification', async () => {
    const served = makeHandler()
    expect(await served.handle({ jsonrpc: '2.0', method: 'message/send' })).toBe(undefined)
  })
})
