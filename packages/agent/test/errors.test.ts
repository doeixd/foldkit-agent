import { Effect, Option, Schema, Tracer } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { type Message, type Model, Message as MessageUnion, emptyModel } from './todoApp.js'

const TodoAgent = Agent.forModel<Model>()

const definition = TodoAgent.define({
  messages: TodoAgent.expose(MessageUnion, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: () => false,
    },
  }),
  resources: [],
})

const runtime = (model: Model = emptyModel) =>
  TodoAgent.bind({
    definition,
    host: { model: () => model, dispatch: (_: Message) => {} },
  })

const failureOf = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect))
  if (result._tag !== 'Failure') throw new Error('Expected a failure')
  return result.failure
}

describe('agent failures', () => {
  it('carry a message written for the calling agent', () => {
    expect(failureOf(runtime().messages.dispatch('nope', {})).message).toBe(
      'No such capability: nope',
    )
    expect(failureOf(runtime().messages.dispatch('delete_todo', { id: 'a' })).message).toBe(
      'Capability "delete_todo" is not available right now',
    )
    expect(
      failureOf(runtime().messages.dispatch('create_todo', { title: 42 })).message,
    ).toBe('Invalid input for "create_todo"')
    expect(failureOf(runtime().resources.read('todos')).message).toBe(
      'Cannot read resource "todos": no such resource',
    )
  })

  it('never puts application internals in the message', () => {
    const failure = failureOf(runtime().messages.dispatch('create_todo', { title: 42 }))

    // The decode failure is kept on the error for the application...
    expect(failure).toHaveProperty('cause')
    // ...but the agent-facing message does not restate it.
    expect(failure.message).not.toMatch(/Schema|expected|Struct/i)
  })

  it('are Errors, so they behave in a stack trace', () => {
    const failure = failureOf(runtime().messages.dispatch('nope', {}))

    expect(failure).toBeInstanceOf(Error)
    expect(failure._tag).toBe('AgentUnknownCapabilityError')
  })

  it('encode to plain JSON, so an adapter can send one across a boundary', () => {
    const model = { ...emptyModel, selectedTodoId: Option.some('a') }
    const failure = failureOf(runtime(model).messages.dispatch('delete_todo', { id: 'a' }))

    expect(Schema.encodeUnknownSync(Agent.AuthorizationError)(failure)).toEqual({
      _tag: 'AgentAuthorizationError',
      capability: 'delete_todo',
      tag: 'RequestedDeleteTodo',
      message: 'Not authorized to invoke "delete_todo"',
    })
  })

  it('can be caught by tag', () => {
    const recovered = Effect.runSync(
      runtime().messages.dispatch('nope', {}).pipe(
        Effect.catchTag('AgentUnknownCapabilityError', error =>
          Effect.succeed(`handled ${error.capability}`),
        ),
        Effect.orElseSucceed(() => 'wrong branch'),
      ),
    )

    expect(recovered).toBe('handled nope')
  })
})

describe('tracing', () => {
  /** Collects the spans an effect opens, as documented on Tracer.SpanOptions. */
  const spansOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<ReadonlyArray<Tracer.NativeSpan>> => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })

    await Effect.runPromise(
      Effect.provideService(Effect.ignore(effect), Tracer.Tracer, tracer),
    )
    return spans
  }

  it('opens a named span for a dispatch', async () => {
    const spans = await spansOf(
      runtime().messages.dispatch('create_todo', { title: 'x' }, { transport: 'mcp', id: 'inv-9' }),
    )

    const span = spans.find(candidate => candidate.name === 'Agent.dispatch')
    expect(span).toBeDefined()
    expect(span?.attributes.get('agent.capability')).toBe('create_todo')
    expect(span?.attributes.get('agent.transport')).toBe('mcp')
    expect(span?.attributes.get('agent.invocation')).toBe('inv-9')
  })

  it('annotates the span even when the capability is refused', async () => {
    const spans = await spansOf(runtime().messages.dispatch('delete_todo', { id: 'a' }))

    const span = spans.find(candidate => candidate.name === 'Agent.dispatch')
    expect(span?.attributes.get('agent.capability')).toBe('delete_todo')
    expect(span?.attributes.get('agent.transport')).toBe('in-app')
  })
})
