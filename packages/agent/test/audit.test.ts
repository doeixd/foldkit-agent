import { Duration, Effect, Option } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import type { AnyMessage, Completion } from '../src/types.js'
import { type Message, type Model, Message as MessageUnion, emptyModel } from './todoApp.js'

const TodoAgent = Agent.forModel<Model, { readonly user: string; readonly token: string }>()

const definition = TodoAgent.define({
  messages: TodoAgent.expose(MessageUnion, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: ({ principal }) => principal.user === 'alice',
    },
  }),
})

let model: Model
let dispatched: Array<Message>
let principal: { readonly user: string; readonly token: string }

const runtimeWith = (audit: Agent.AuditSink) =>
  TodoAgent.bind({
    definition,
    audit,
    host: {
      model: () => model,
      dispatch: (message: Message) => void dispatched.push(message),
      principal: () => principal,
    },
  })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

beforeEach(() => {
  model = emptyModel
  dispatched = []
  principal = { user: 'alice', token: 'secret-token' }
})

describe('what is recorded', () => {
  it('records a dispatch', async () => {
    const audit = Agent.auditLog()
    await run(
      runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }, { transport: 'mcp' }),
    )

    expect(audit.entries()).toMatchObject([
      {
        capability: 'create_todo',
        tag: 'RequestedCreateTodo',
        transport: 'mcp',
        decision: 'dispatched',
        outcome: 'dispatched',
      },
    ])
  })

  it('records each execution of a reused Effect under its own invocation id', async () => {
    const audit = Agent.auditLog()
    const operation = runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' })

    await run(operation)
    await run(operation)

    const [first, second] = audit.entries()
    expect(second!.invocation).not.toEqual(first!.invocation)
  })

  it('records a refusal, which is the interesting one', async () => {
    const audit = Agent.auditLog()
    principal = { user: 'mallory', token: 'secret-token' }
    model = { ...emptyModel, selectedTodoId: Option.some('a') }

    await run(runtimeWith(audit).messages.dispatch('delete_todo', { id: 'a' }))

    expect(audit.entries()).toMatchObject([
      { capability: 'delete_todo', decision: 'refused', outcome: 'AgentAuthorizationError' },
    ])
    expect(dispatched).toEqual([])
  })

  it('records every kind of refusal', async () => {
    const audit = Agent.auditLog()
    const runtime = runtimeWith(audit)

    await run(runtime.messages.dispatchUnknown('nope', {}))
    await run(runtime.messages.dispatchUnknown('create_todo', { title: 42 }))
    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(audit.entries().map(entry => entry.outcome)).toEqual([
      'AgentUnknownCapabilityError',
      'AgentInvalidInputError',
      'AgentCapabilityUnavailableError',
    ])
  })

  it('names the capability the caller asked for, even when it does not exist', async () => {
    const audit = Agent.auditLog()
    await run(runtimeWith(audit).messages.dispatchUnknown('drop_database', {}))

    expect(audit.entries()[0]?.capability).toBe('drop_database')
  })

  it('records one entry per invocation, with its id and transport', async () => {
    const audit = Agent.auditLog()
    const runtime = runtimeWith(audit)

    await run(runtime.messages.dispatch('create_todo', { title: 'a' }, { id: 'one' }))
    await run(runtime.messages.dispatch('create_todo', { title: 'b' }, { id: 'two' }))

    expect(audit.entries().map(entry => entry.invocation)).toEqual(['one', 'two'])
    expect(audit.entries()[0]?.transport).toBe('in-app')
  })
})

describe('what is never recorded', () => {
  it('omits the input by default', async () => {
    const audit = Agent.auditLog()
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'Buy milk' }))

    // Input is caller-supplied and may carry anything.
    expect(audit.entries()[0]).not.toHaveProperty('input')
    expect(JSON.stringify(audit.entries())).not.toContain('Buy milk')
  })

  it('omits the principal without a projection', async () => {
    const audit = Agent.auditLog()
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    expect(audit.entries()[0]).not.toHaveProperty('principal')
    expect(JSON.stringify(audit.entries())).not.toContain('secret-token')
  })

  it('records only what the principal projection returns', async () => {
    const audit = Agent.auditLog({ principal: caller => (caller as { user: string }).user })
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    expect(audit.entries()[0]?.principal).toBe('alice')
    // The token was on the principal and must not have travelled with it.
    expect(JSON.stringify(audit.entries())).not.toContain('secret-token')
  })

  it('never records the Model', async () => {
    const audit = Agent.auditLog({ includeInput: true })
    model = { ...emptyModel, todos: [{ id: 'private', title: 'Model contents', completed: false }] }

    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    expect(JSON.stringify(audit.entries())).not.toContain('Model contents')
  })

  it('replaces redacted fields when input is recorded', async () => {
    const audit = Agent.auditLog({ includeInput: true, redact: ['title'] })
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'Buy milk' }))

    expect(audit.entries()[0]?.input).toEqual({ title: '[redacted]' })
  })

  it('keeps the fields that were not redacted', async () => {
    const audit = Agent.auditLog({ includeInput: true, redact: ['secret'] })
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'Buy milk' }))

    expect(audit.entries()[0]?.input).toEqual({ title: 'Buy milk' })
  })
})

describe('the principal is resolved once per dispatch', () => {
  const runtimeResolving = (
    audit: Agent.AuditSink,
    resolvePrincipal: () => { readonly user: string; readonly token: string },
  ) =>
    TodoAgent.bind({
      definition,
      audit,
      host: {
        model: () => model,
        dispatch: (message: Message) => void dispatched.push(message),
        principal: resolvePrincipal,
      },
    })

  it('calls the resolver exactly once', async () => {
    let calls = 0
    const audit = Agent.auditLog({ principal: caller => (caller as { user: string }).user })
    const runtime = runtimeResolving(audit, () => {
      calls += 1
      return principal
    })

    await run(runtime.messages.dispatch('create_todo', { title: 'x' }))
    expect(calls).toBe(1)

    await run(runtime.messages.dispatch('create_todo', { title: 'y' }))
    expect(calls).toBe(2)
  })

  it('records the principal that authorized the dispatch, not a later answer', async () => {
    const audit = Agent.auditLog({ principal: caller => (caller as { user: string }).user })
    let calls = 0
    const runtime = runtimeResolving(audit, () => {
      calls += 1
      return calls === 1 ? principal : { user: 'mallory', token: 'other' }
    })

    await run(runtime.messages.dispatch('create_todo', { title: 'x' }))

    expect(audit.entries()[0]?.principal).toBe('alice')
  })

  it('does not fail a dispatch whose resolver is one-shot', async () => {
    const audit = Agent.auditLog({ principal: caller => (caller as { user: string }).user })
    let calls = 0
    const runtime = runtimeResolving(audit, () => {
      calls += 1
      if (calls > 1) throw new Error('resolver called twice')
      return principal
    })

    const result = await run(runtime.messages.dispatch('create_todo', { title: 'x' }))

    expect(result._tag).toBe('Success')
    expect(dispatched).toHaveLength(1)
    expect(audit.entries()[0]?.principal).toBe('alice')
  })

  it('records no principal when the dispatch is refused before one is resolved', async () => {
    let calls = 0
    const audit = Agent.auditLog({ principal: caller => caller })
    const runtime = runtimeResolving(audit, () => {
      calls += 1
      return principal
    })

    await run(runtime.messages.dispatchUnknown('no_such_capability', {}))

    expect(calls).toBe(0)
    expect(audit.entries()).toMatchObject([{ decision: 'refused', principal: undefined }])
  })
})

describe('recorded input is a snapshot', () => {
  const nestedDefinition = TodoAgent.define({
    messages: TodoAgent.expose(MessageUnion, {
      ReceivedTodos: { name: 'receive_todos', description: 'Load todos' },
    }),
  })

  const record = (audit: Agent.AuditSink, input: unknown) =>
    audit.record({
      invocation: { id: 'i', transport: 'in-app' },
      capability: 'create_todo',
      tag: 'RequestedCreateTodo',
      principal: undefined,
      decision: 'dispatched',
      outcome: 'dispatched',
      input,
    })

  it('does not follow a later mutation of the caller-owned input', async () => {
    const audit = Agent.auditLog({ includeInput: true })
    const runtime = TodoAgent.bind({
      definition: nestedDefinition,
      audit,
      host: {
        model: () => model,
        dispatch: (message: Message) => void dispatched.push(message),
        principal: () => principal,
      },
    })

    const input = { todos: [{ id: 'a', title: 'original', completed: false }] }
    await run(runtime.messages.dispatch('receive_todos', input))

    input.todos[0]!.title = 'rewritten'
    input.todos.push({ id: 'b', title: 'appended', completed: false })

    expect(audit.entries()[0]?.input).toEqual({
      todos: [{ id: 'a', title: 'original', completed: false }],
    })
  })

  it('snapshots dates, maps and sets rather than aliasing them', () => {
    const audit = Agent.auditLog({ includeInput: true })
    const when = new Date(0)
    const tags = new Set(['one'])
    const byId = new Map([['a', { title: 'original' }]])

    record(audit, { when, tags, byId })

    when.setTime(5000)
    tags.add('two')
    byId.get('a')!.title = 'rewritten'

    const input = audit.entries()[0]?.input as {
      when: Date
      tags: Set<string>
      byId: Map<string, { title: string }>
    }
    expect(input.when.getTime()).toBe(0)
    expect([...input.tags]).toEqual(['one'])
    expect(input.byId.get('a')).toEqual({ title: 'original' })
  })

  it('records a self-referential input without looping', () => {
    const audit = Agent.auditLog({ includeInput: true })
    const nested: Record<string, unknown> = { value: 'original' }
    nested.self = nested

    record(audit, { nested })

    const recorded = (audit.entries()[0]?.input as { nested: Record<string, unknown> }).nested
    nested.value = 'rewritten'

    expect(recorded.value).toBe('original')
    expect(recorded.self).toBe(recorded)
  })

  it('still redacts only the top-level fields named', () => {
    const audit = Agent.auditLog({ includeInput: true, redact: ['token'] })

    record(audit, { token: 'secret', nested: { token: 'nested-secret' } })

    expect(audit.entries()[0]?.input).toEqual({
      token: '[redacted]',
      nested: { token: 'nested-secret' },
    })
  })
})

describe('the log itself', () => {
  it('is bounded, dropping the oldest', async () => {
    const audit = Agent.auditLog({ capacity: 3 })
    const runtime = runtimeWith(audit)

    for (const title of ['a', 'b', 'c', 'd', 'e']) {
      await run(runtime.messages.dispatch('create_todo', { title }, { id: title }))
    }

    expect(audit.entries().map(entry => entry.invocation)).toEqual(['c', 'd', 'e'])
  })

  it('can be cleared', async () => {
    const audit = Agent.auditLog()
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    audit.clear()

    expect(audit.entries()).toEqual([])
  })

  it('hands back a copy, so a reader cannot rewrite history', async () => {
    const audit = Agent.auditLog()
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    ;(audit.entries() as Array<unknown>).length = 0

    expect(audit.entries()).toHaveLength(1)
  })

  it('stamps entries from the clock', async () => {
    const audit = Agent.auditLog({ clock: () => 1234 })
    await run(runtimeWith(audit).messages.dispatch('create_todo', { title: 'x' }))

    expect(audit.entries()[0]?.at).toBe(1234)
  })
})

describe('a sink that misbehaves', () => {
  it('never fails the dispatch', async () => {
    const exploding: Agent.AuditSink = {
      record: () => {
        throw new Error('the audit backend is down')
      },
    }

    const result = await run(
      runtimeWith(exploding).messages.dispatch('create_todo', { title: 'x' }),
    )

    // Accountability must not become a new way for a capability to break.
    expect(result._tag).toBe('Success')
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'x' }])
  })

  it('never turns a refusal into something else', async () => {
    const exploding: Agent.AuditSink = {
      record: () => {
        throw new Error('the audit backend is down')
      },
    }

    const result = await run(runtimeWith(exploding).messages.dispatchUnknown('nope', {}))

    expect(result._tag).toBe('Failure')
  })
})

describe('without an audit sink', () => {
  it('records nothing and dispatches as before', async () => {
    const runtime = TodoAgent.bind({
      definition,
      host: {
        model: () => model,
        dispatch: (message: Message) => void dispatched.push(message),
        principal: () => principal,
      },
    })

    await run(runtime.messages.dispatch('create_todo', { title: 'x' }))

    expect(dispatched).toHaveLength(1)
  })
})

/**
 * A completion contract turns a dispatch into two facts: that the Message was
 * sent, and what became of it. The record has to keep them apart -- a timeout
 * is not a refusal, and nothing about it was undone.
 */
describe('a dispatch that was accepted but did not complete', () => {
  const completingHost = (options: {
    readonly complete?: (message: Message, emit: (message: Message) => void) => void
    readonly throwOnDispatch?: boolean
  }) => {
    const listeners = new Set<(message: AnyMessage) => void>()
    const emit = (message: Message): void => {
      for (const listener of [...listeners]) listener(message)
    }
    return {
      model: () => emptyModel,
      dispatch: (message: Message) => {
        if (options.throwOnDispatch === true) throw new Error('the Runtime port is closed')
        dispatched.push(message)
        options.complete?.(message, emit)
      },
      principal: () => principal,
      observe: (listener: (message: AnyMessage) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  }

  const completingRuntime = (
    audit: Agent.AuditSink,
    host: ReturnType<typeof completingHost>,
    completion: Completion<{ readonly id: string }, Message, Message>,
  ) =>
    Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, {
          RequestedDeleteTodo: { name: 'delete_todo', description: 'Delete a todo', completion },
        }),
      }),
      audit,
      host,
    })

  const deleted = MessageUnion.ReceivedTodos({ todos: [] })

  it('records a completion timeout as dispatched, not as a refusal', async () => {
    const audit = Agent.auditLog()
    const host = completingHost({})
    const runtime = completingRuntime(audit, host, {
      success: MessageUnion.ReceivedTodos,
      timeout: Duration.millis(20),
    })

    const result = await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(result._tag).toBe('Failure')
    // The Message reached the host. Recording that as a refusal would say the
    // opposite of what happened to the Model.
    expect(dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'a' }])
    expect(audit.entries()).toMatchObject([
      {
        capability: 'delete_todo',
        tag: 'RequestedDeleteTodo',
        decision: 'dispatched',
        outcome: 'timeout',
      },
    ])
  })

  it('records a declared failure Message as dispatched and failed', async () => {
    const audit = Agent.auditLog()
    const host = completingHost({
      complete: (_, emit) => emit(MessageUnion.FailedToLoadTodos({ message: 'nope' })),
    })
    const runtime = completingRuntime(audit, host, {
      success: MessageUnion.ReceivedTodos,
      failure: MessageUnion.FailedToLoadTodos,
      timeout: Duration.millis(20),
    })

    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(audit.entries()).toMatchObject([{ decision: 'dispatched', outcome: 'failed' }])
  })

  it('records a completion that arrived as dispatched and completed', async () => {
    const audit = Agent.auditLog()
    const host = completingHost({ complete: (_, emit) => emit(deleted) })
    const runtime = completingRuntime(audit, host, {
      success: MessageUnion.ReceivedTodos,
      timeout: Duration.millis(20),
    })

    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(audit.entries()).toMatchObject([{ decision: 'dispatched', outcome: 'completed' }])
  })

  it('records an interrupted wait as dispatched, because nothing was undone', async () => {
    const audit = Agent.auditLog()
    const host = completingHost({})
    const runtime = completingRuntime(audit, host, {
      success: MessageUnion.ReceivedTodos,
      timeout: Duration.seconds(30),
    })

    // Interruption stops the waiting, never the Message that is already in the
    // Runtime -- so the record may not read as a decision not to act.
    await Effect.runPromise(
      Effect.exit(
        Effect.timeout(runtime.messages.dispatch('delete_todo', { id: 'a' }), Duration.millis(20)),
      ),
    )

    expect(dispatched).toEqual([{ _tag: 'RequestedDeleteTodo', id: 'a' }])
    expect(audit.entries()).toMatchObject([{ decision: 'dispatched', outcome: 'interrupted' }])
  })

  it('claims neither delivery nor refusal when the host itself raised', async () => {
    const audit = Agent.auditLog()
    const host = completingHost({ throwOnDispatch: true })
    const runtime = completingRuntime(audit, host, {
      success: MessageUnion.ReceivedTodos,
      timeout: Duration.millis(20),
    })

    const result = await Effect.runPromise(
      Effect.exit(runtime.messages.dispatch('delete_todo', { id: 'a' })),
    )

    expect(result._tag).toBe('Failure')
    expect(dispatched).toEqual([])
    // Nothing here can tell whether the Runtime saw the Message, so the record
    // says so rather than filing it beside a policy refusal.
    expect(audit.entries()).toMatchObject([
      { capability: 'delete_todo', tag: 'RequestedDeleteTodo', decision: 'unknown' },
    ])
  })
})

describe('every failure mode is recorded as what it was', () => {
  it('records each refusal as refused, with the Message never dispatched', async () => {
    const audit = Agent.auditLog()
    const runtime = runtimeWith(audit)
    const aborted = new AbortController()
    aborted.abort()

    await run(runtime.messages.dispatchUnknown('nope', {}))
    await run(runtime.messages.dispatchUnknown('create_todo', { title: 42 }))
    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))
    await run(runtime.messages.dispatch('create_todo', { title: 'x' }, { signal: aborted.signal }))
    model = { ...emptyModel, selectedTodoId: Option.some('a') }
    principal = { user: 'mallory', token: 'secret-token' }
    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(audit.entries().map(entry => [entry.decision, entry.outcome])).toEqual([
      ['refused', 'AgentUnknownCapabilityError'],
      ['refused', 'AgentInvalidInputError'],
      ['refused', 'AgentCapabilityUnavailableError'],
      ['refused', 'AgentCancelledError'],
      ['refused', 'AgentAuthorizationError'],
    ])
    expect(dispatched).toEqual([])
  })

  it('names the capability of a refusal that carries no Message tag', async () => {
    const audit = Agent.auditLog()
    const aborted = new AbortController()
    aborted.abort()

    await run(
      runtimeWith(audit).messages.dispatch(
        'create_todo',
        { title: 'x' },
        { signal: aborted.signal },
      ),
    )

    expect(audit.entries()).toMatchObject([
      { capability: 'create_todo', tag: 'RequestedCreateTodo' },
    ])
  })
})
