import { Duration, Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import type { Completion } from '../src/types.js'
import { type Message, type Model, Message as MessageUnion, emptyModel } from './todoApp.js'

/**
 * A host that runs an `update` of the test's choosing and reports every Message
 * it processes, which is what a completion contract needs to observe.
 */
const makeHost = (update?: (message: Message, emit: (message: Message) => void) => void) => {
  const dispatched: Array<Message> = []
  const listeners = new Set<(message: Message) => void>()

  const emit = (message: Message): void => {
    for (const listener of [...listeners]) listener(message)
  }

  return {
    dispatched,
    emit,
    listeners,
    host: {
      model: () => emptyModel,
      dispatch: (message: Message) => {
        dispatched.push(message)
        emit(message)
        update?.(message, emit)
      },
      observe: (listener: (message: Message) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

const contractOf = (completion: Completion<{ readonly id: string }, Message, Message>) =>
  Agent.define({
    messages: Agent.expose(MessageUnion, {
      RequestedDeleteTodo: { name: 'delete_todo', description: 'Delete a todo', completion },
    }),
  })

const deletedTodos = (ids: ReadonlyArray<string>) =>
  MessageUnion.ReceivedTodos({ todos: ids.map(id => ({ id, title: id, completed: true })) })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

describe('completion tracking', () => {
  it('reports the Message that completed the operation', async () => {
    const { host } = makeHost((_, emit) => emit(deletedTodos([])))
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos }),
      host,
    })

    const result = await Effect.runPromise(
      runtime.messages.dispatch('delete_todo', { id: 'todo-1' }),
    )

    expect(result.completion).toMatchObject({ status: 'completed' })
    expect(result.completion?.message._tag).toBe('ReceivedTodos')
  })

  it('catches a completion that update produces synchronously', async () => {
    // The listener has to be attached before the dispatch, or this is lost.
    const { host } = makeHost((_, emit) => emit(deletedTodos([])))
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(50) }),
      host,
    })

    const result = await run(runtime.messages.dispatch('delete_todo', { id: 'todo-1' }))

    expect(result._tag).toBe('Success')
  })

  it('reports a declared failure Message as failed, not as an error', async () => {
    const { host } = makeHost((_, emit) =>
      emit(MessageUnion.FailedToLoadTodos({ message: 'nope' })),
    )
    const runtime = Agent.bind({
      definition: contractOf({
        success: MessageUnion.ReceivedTodos,
        failure: MessageUnion.FailedToLoadTodos,
      }),
      host,
    })

    const result = await Effect.runPromise(
      runtime.messages.dispatch('delete_todo', { id: 'todo-1' }),
    )

    expect(result.completion).toMatchObject({ status: 'failed' })
  })

  it('times out without claiming anything was undone', async () => {
    const { host, dispatched } = makeHost()
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(10) }),
      host,
    })

    const result = await run(runtime.messages.dispatch('delete_todo', { id: 'todo-1' }))

    expect(result._tag).toBe('Failure')
    const failure = (result as { failure: { _tag: string; message: string } }).failure
    expect(failure._tag).toBe('AgentCompletionTimeoutError')
    expect(failure.message).toMatch(/still reached update/)
    // The Message was dispatched. Only the waiting stopped.
    expect(dispatched).toHaveLength(1)
  })

  it('releases its listener on every exit path', async () => {
    const { host, listeners } = makeHost((_, emit) => emit(deletedTodos([])))
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(10) }),
      host,
    })

    await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))
    expect(listeners.size).toBe(0)

    const timingOut = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(10) }),
      host: makeHost().host,
    })
    await run(timingOut.messages.dispatch('delete_todo', { id: 'b' }))
    expect(listeners.size).toBe(0)
  })

  type HostDispatch = () => void | Promise<void> | Effect.Effect<void>

  const failingDispatches: ReadonlyArray<readonly [string, HostDispatch]> = [
    [
      'throws synchronously',
      () => {
        throw new Error('nope')
      },
    ],
    ['rejects its Promise', () => Promise.reject(new Error('nope'))],
    ['returns a dying Effect', () => Effect.die('nope')],
  ]

  it.each(failingDispatches)(
    'releases its listener when the host dispatch %s',
    async (_label, dispatch) => {
      const listeners = new Set<(message: Message) => void>()
      const runtime = Agent.bind({
        definition: contractOf({
          success: MessageUnion.ReceivedTodos,
          timeout: Duration.seconds(30),
        }),
        host: {
          model: () => emptyModel,
          dispatch: (_: Message) => dispatch(),
          observe: (listener: (message: Message) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      })

      const exit = await Effect.runPromiseExit(
        runtime.messages.dispatch('delete_todo', { id: 'a' }),
      )

      expect(exit._tag).toBe('Failure')
      // The timeout is far longer than this test: a listener still here is
      // leaked, not merely waiting.
      expect(listeners.size).toBe(0)
    },
  )

  it('ignores a completing Message that arrives after the timeout', async () => {
    const { host, emit } = makeHost()
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(10) }),
      host,
    })

    const result = await run(runtime.messages.dispatch('delete_todo', { id: 'todo-1' }))
    expect(result._tag).toBe('Failure')

    // A settled invocation must not settle twice.
    expect(() => emit(deletedTodos([]))).not.toThrow()
  })

  it('gives each concurrent invocation the Message it owns', async () => {
    const { host, emit } = makeHost()
    const runtime = Agent.bind({
      definition: contractOf({
        success: MessageUnion.ReceivedTodos,
        correlate: (request, result) =>
          result._tag === 'ReceivedTodos' && result.todos[0]?.id === request.id,
        timeout: Duration.seconds(1),
      }),
      host,
    })

    const first = Effect.runPromise(runtime.messages.dispatch('delete_todo', { id: 'todo-1' }))
    const second = Effect.runPromise(runtime.messages.dispatch('delete_todo', { id: 'todo-2' }))

    emit(deletedTodos(['todo-2']))
    emit(deletedTodos(['todo-1']))

    expect((await first).completion?.message).toMatchObject({ todos: [{ id: 'todo-1' }] })
    expect((await second).completion?.message).toMatchObject({ todos: [{ id: 'todo-2' }] })
  })

  it('keeps the first matching Message when two arrive before it resumes', async () => {
    // Both are emitted synchronously inside dispatch, so the waiter sees the
    // second while still holding the first. First match wins.
    const { host } = makeHost((_, emit) => {
      emit(deletedTodos(['first']))
      emit(deletedTodos(['second']))
    })
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: Duration.millis(50) }),
      host,
    })

    const result = await Effect.runPromise(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect(result.completion?.message).toMatchObject({ todos: [{ id: 'first' }] })
  })

  it('leaves capabilities without a contract at validated dispatch', async () => {
    const { host } = makeHost()
    const runtime = Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, { RequestedCreateTodo: 'Create a todo' }),
      }),
      host,
    })

    const result = await Effect.runPromise(
      runtime.messages.dispatch('requested_create_todo', { title: 'x' }),
    )

    expect(result).not.toHaveProperty('completion')
  })

  it('never subscribes for an invocation that was refused', async () => {
    const { host, listeners } = makeHost()
    const runtime = Agent.bind({
      definition: Agent.define({
        messages: Agent.expose(MessageUnion, {
          RequestedDeleteTodo: {
            name: 'delete_todo',
            description: 'Delete a todo',
            authorize: () => false,
            completion: { success: MessageUnion.ReceivedTodos },
          },
        }),
      }),
      host,
    })

    const result = await run(runtime.messages.dispatch('delete_todo', { id: 'a' }))

    expect((result as { failure: { _tag: string } }).failure._tag).toBe('AgentAuthorizationError')
    expect(listeners.size).toBe(0)
  })
})

describe('a contract that declares completion', () => {
  it('is refused at bind when the host cannot observe Messages', () => {
    expect(() =>
      Agent.bind({
        definition: contractOf({ success: MessageUnion.ReceivedTodos }),
        host: { model: () => emptyModel, dispatch: (_: Message) => {} },
      }),
    ).toThrow(/cannot observe Messages/)
  })

  it('names the capabilities that need it', () => {
    expect(() =>
      Agent.bind({
        definition: contractOf({ success: MessageUnion.ReceivedTodos }),
        host: { model: () => emptyModel, dispatch: (_: Message) => {} },
      }),
    ).toThrow(/"delete_todo"/)
  })

  it('rejects a contract naming no success Message', () => {
    expect(() => contractOf({ success: [] })).toThrow(/names no success Message/)
  })

  it('rejects a Message listed as both success and failure', () => {
    expect(() =>
      contractOf({
        success: MessageUnion.ReceivedTodos,
        failure: MessageUnion.ReceivedTodos,
      }),
    ).toThrow(/both a success and a failure/)
  })
})

describe('cancelling while waiting for completion', () => {
  let host: ReturnType<typeof makeHost>

  beforeEach(() => {
    host = makeHost()
  })

  /** Long enough that a test finishing quickly cannot be a timeout in disguise. */
  const NEVER = Duration.seconds(30)

  const waiting = (timeout: Duration.Duration = NEVER) =>
    Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout }),
      host: host.host,
    })

  it('stops waiting and says the Message was still dispatched', async () => {
    const controller = new AbortController()
    const started = Date.now()

    const pending = run(
      waiting().messages.dispatch('delete_todo', { id: 'a' }, { signal: controller.signal }),
    )
    // Aborted after dispatch: the Message is already in the Runtime, and the
    // two synchronous pre-dispatch checks are long past.
    await Promise.resolve()
    controller.abort()
    const result = await pending

    expect(Date.now() - started).toBeLessThan(1000)
    const failure = (result as { failure: { _tag: string; dispatched: boolean; message: string } })
      .failure
    expect(failure._tag).toBe('AgentCancelledError')
    expect(failure.dispatched).toBe(true)
    expect(failure.message).toMatch(/still reached update/)
    // Nothing was undone, and the listener is released by the one finalizer.
    expect(host.dispatched).toHaveLength(1)
    expect(host.listeners.size).toBe(0)
  })

  it('keeps the completion that already arrived rather than settling twice', async () => {
    const controller = new AbortController()
    host = makeHost((_, emit) => emit(deletedTodos([])))

    const result = await run(
      waiting().messages.dispatch('delete_todo', { id: 'a' }, { signal: controller.signal }),
    )
    controller.abort()

    expect(result._tag).toBe('Success')
    expect(
      (result as { success: { completion: { status: string } } }).success.completion.status,
    ).toBe('completed')
    expect(host.listeners.size).toBe(0)
  })

  it('settles a wait whose signal aborted while the host was still dispatching', async () => {
    // The abort lands after the last pre-dispatch check and before the wait
    // begins, so nothing is listening for it when it fires.
    const controller = new AbortController()
    host = makeHost()
    const slow = {
      ...host.host,
      dispatch: async (message: Message) => {
        host.dispatched.push(message)
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 5))
      },
    }
    const runtime = Agent.bind({
      definition: contractOf({ success: MessageUnion.ReceivedTodos, timeout: NEVER }),
      host: slow,
    })

    const result = await run(
      runtime.messages.dispatch('delete_todo', { id: 'a' }, { signal: controller.signal }),
    )

    const failure = (result as { failure: { _tag: string; dispatched: boolean } }).failure
    expect(failure._tag).toBe('AgentCancelledError')
    expect(failure.dispatched).toBe(true)
    expect(host.dispatched).toHaveLength(1)
    expect(host.listeners.size).toBe(0)
  })

  it('removes its abort listener when the completion arrives instead', async () => {
    // Emitted a tick later, so the abort listener is certainly registered by
    // the time the completion resolves the race.
    host = makeHost((_, emit) => void setTimeout(() => emit(deletedTodos([])), 5))
    const signal = new AbortController().signal
    let listening = 0
    const { addEventListener, removeEventListener } = AbortSignal.prototype
    signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
      listening += 1
      addEventListener.apply(signal, args)
    }
    signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
      listening -= 1
      removeEventListener.apply(signal, args)
    }

    await run(waiting().messages.dispatch('delete_todo', { id: 'a' }, { signal }))

    // A long-lived signal would otherwise accumulate one listener per dispatch.
    expect(listening).toBe(0)
  })

  it('refuses before dispatch when the signal is already aborted', async () => {
    const result = await run(
      waiting().messages.dispatch('delete_todo', { id: 'a' }, { signal: AbortSignal.abort() }),
    )

    const failure = (result as { failure: { _tag: string; dispatched: boolean } }).failure
    expect(failure._tag).toBe('AgentCancelledError')
    expect(failure.dispatched).toBe(false)
    expect(host.dispatched).toEqual([])
    expect(host.listeners.size).toBe(0)
  })

  it('still times out when no signal was supplied', async () => {
    const result = await run(
      waiting(Duration.millis(20)).messages.dispatch('delete_todo', { id: 'a' }),
    )

    expect((result as { failure: { _tag: string } }).failure._tag).toBe(
      'AgentCompletionTimeoutError',
    )
    expect(host.listeners.size).toBe(0)
  })
})
