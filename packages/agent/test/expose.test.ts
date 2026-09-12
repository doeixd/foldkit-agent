import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/index.js'
import { Message, emptyModel } from './todoApp.js'

describe('Agent.expose', () => {
  it('derives a descriptor from the existing Message union', () => {
    const messages = Agent.expose(Message, {
      RequestedDeleteTodo: { name: 'delete_todo', description: 'Delete a todo' },
    })

    expect(messages.variants).toHaveLength(1)
    const [variant] = messages.variants
    expect(variant?.tag).toBe('RequestedDeleteTodo')
    expect(variant?.name).toBe('delete_todo')
    expect(variant?.description).toBe('Delete a todo')
  })

  it('normalizes the Message tag when no name is given', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: { description: 'Rename a todo' },
    })

    expect(messages.variants[0]?.name).toBe('requested_rename_todo')
    // The internal tag is never renamed.
    expect(messages.variants[0]?.tag).toBe('RequestedRenameTodo')
  })

  it('strips _tag from the derived input schema', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: { name: 'rename_todo', description: 'Rename a todo' },
    })

    expect(messages.variants[0]?.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
    })
    expect(messages.variants[0]?.inputJsonSchema).not.toHaveProperty('properties._tag')
  })

  it('gives a payload-free Message a closed empty object schema', () => {
    const messages = Agent.expose(Message, {
      ClearedSelection: { name: 'clear_selection', description: 'Clear the selection' },
    })

    expect(messages.variants[0]?.inputJsonSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('uses the external input schema when one is supplied', () => {
    const messages = Agent.expose(Message, {
      RequestedRenameTodo: {
        name: 'rename_todo',
        description: 'Rename a todo',
        input: Schema.Struct({ id: Schema.String }),
        toMessage: ({ id }) => ({ id, title: 'Untitled' }),
      },
    })

    expect(messages.variants[0]?.inputJsonSchema).toMatchObject({
      type: 'object',
      required: ['id'],
    })
    expect(messages.variants[0]?.inputJsonSchema).not.toHaveProperty('properties.title')
  })

  it('rejects a tag that is not part of the union', () => {
    expect(() =>
      // @ts-expect-error NotAMessage is not a variant of this Message union.
      Agent.expose(Message, { NotAMessage: { description: 'nope' } }),
    ).toThrow(/not a variant/)
  })

  it('rejects input without toMessage', () => {
    expect(() =>
      Agent.expose(Message, {
        // @ts-expect-error toMessage is required whenever input is provided.
        RequestedDeleteTodo: { description: 'Delete a todo', input: Schema.Struct({}) },
      }),
    ).toThrow(/without "toMessage"/)
  })

  it('rejects a name that no tool protocol would accept', () => {
    for (const name of ['delete todo', 'delete/todo', 'delete.todo', '', 'x'.repeat(129)]) {
      expect(() =>
        Agent.expose(Message, {
          RequestedDeleteTodo: { name, description: 'Delete a todo' },
        }),
      ).toThrow(/is not a valid capability name/)
    }
  })

  it('accepts the names tool protocols do allow', () => {
    for (const name of ['delete_todo', 'delete-todo', 'deleteTodo2', 'x'.repeat(128)]) {
      expect(
        Agent.expose(Message, {
          RequestedDeleteTodo: { name, description: 'Delete a todo' },
        }).variants[0]?.name,
      ).toBe(name)
    }
  })

  it('rejects two capabilities sharing a name', () => {
    expect(() =>
      Agent.expose(Message, {
        RequestedCreateTodo: { name: 'todo', description: 'Create' },
        RequestedDeleteTodo: { name: 'todo', description: 'Delete' },
      }),
    ).toThrow(/Duplicate exposed capability name/)
  })
})

describe('payload-free capabilities', () => {
  const messages = Agent.expose(Message, {
    ClearedSelection: { name: 'clear_selection', description: 'Clear the selection' },
  })
  const inputSchema = messages.variants[0]!.inputSchema

  const decode = (input: unknown) =>
    Effect.runSync(
      Effect.result(Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: 'error' })(input)),
    )._tag

  it('advertises a closed empty object', () => {
    expect(messages.variants[0]?.inputJsonSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('accepts an empty object', () => {
    expect(decode({})).toBe('Success')
  })

  it('enforces what it advertises', () => {
    // Schema.Struct({}) accepts all of these, which the advertised schema forbids.
    expect(decode({ foo: 1 })).toBe('Failure')
    expect(decode([])).toBe('Failure')
    expect(decode('str')).toBe('Failure')
    expect(decode(42)).toBe('Failure')
  })

  it('refuses undeclared input through the runtime, before update', () => {
    const dispatched: Array<unknown> = []
    const runtime = Agent.bind({
      definition: Agent.make({ messages }),
      host: { model: () => emptyModel, dispatch: message => void dispatched.push(message) },
    })

    const result = Effect.runSync(
      Effect.result(runtime.messages.dispatchUnknown('clear_selection', { unexpected: true })),
    )

    expect(result._tag).toBe('Failure')
    expect(dispatched).toEqual([])
  })
})

describe('an externally declared empty input', () => {
  const messages = Agent.expose(Message, {
    RequestedDeleteTodo: {
      name: 'delete_selected',
      description: 'Delete whichever todo is selected',
      input: Schema.Struct({}),
      toMessage: () => ({ id: 'from-the-model' }),
    },
  })

  it('advertises a closed empty object', () => {
    expect(messages.variants[0]?.inputJsonSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('enforces what it advertises', () => {
    const decode = (input: unknown) =>
      Effect.runSync(
        Effect.result(
          Schema.decodeUnknownEffect(messages.variants[0]!.inputSchema, {
            onExcessProperty: 'error',
          })(input),
        ),
      )._tag

    expect(decode({})).toBe('Success')
    expect(decode({ id: 'injected' })).toBe('Failure')
    expect(decode([])).toBe('Failure')
  })
})

describe('an externally declared empty input that carries checks', () => {
  const messages = Agent.expose(Message, {
    RequestedDeleteTodo: {
      name: 'delete_selected',
      description: 'Delete whichever todo is selected',
      input: Schema.Struct({}).check(Schema.makeFilter(() => 'the caller may never invoke this')),
      toMessage: () => ({ id: 'from-the-model' }),
    },
  })
  const variant = messages.variants[0]!

  const decode = (input: unknown) =>
    Effect.runSync(
      Effect.result(
        Schema.decodeUnknownEffect(variant.inputSchema, { onExcessProperty: 'error' })(input),
      ),
    )._tag

  it("keeps the supplied schema's checks", () => {
    expect(decode({})).toBe('Failure')
  })

  it('refuses input the declared schema rejects, before update', () => {
    const dispatched: Array<unknown> = []
    const runtime = Agent.bind({
      definition: Agent.make({ messages }),
      host: { model: () => emptyModel, dispatch: message => void dispatched.push(message) },
    })

    const result = Effect.runSync(
      Effect.result(runtime.messages.dispatchUnknown('delete_selected', {})),
    )

    expect(result._tag).toBe('Failure')
    expect(dispatched).toEqual([])
  })
})

describe('an externally declared empty input that carries annotations', () => {
  const messages = Agent.expose(Message, {
    RequestedDeleteTodo: {
      description: 'Delete whichever todo is selected',
      input: Schema.Struct({}).annotate({ title: 'Nothing to supply' }),
      toMessage: () => ({ id: 'from-the-model' }),
    },
  })

  it("keeps the supplied schema's annotations", () => {
    const ast = (messages.variants[0]!.inputSchema as { ast: { annotations?: unknown } }).ast
    expect(ast.annotations).toMatchObject({ title: 'Nothing to supply' })
  })
})

describe('an externally declared empty input whose check permits invocation', () => {
  let seen = 0
  const messages = Agent.expose(Message, {
    RequestedDeleteTodo: {
      name: 'delete_selected',
      description: 'Delete whichever todo is selected',
      input: Schema.Struct({}).check(
        Schema.makeFilter(() => {
          seen += 1
          return undefined
        }),
      ),
      toMessage: () => ({ id: 'from-the-model' }),
    },
  })

  it('dispatches, having run the supplied check', () => {
    const before = seen
    const dispatched: Array<unknown> = []
    const runtime = Agent.bind({
      definition: Agent.make({ messages }),
      host: { model: () => emptyModel, dispatch: message => void dispatched.push(message) },
    })

    Effect.runSync(runtime.messages.dispatchUnknown('delete_selected', {}))

    expect(seen).toBe(before + 1)
    expect(dispatched).toHaveLength(1)
  })

  it('still advertises and enforces a closed empty object', () => {
    const variant = messages.variants[0]!
    const decode = (input: unknown) =>
      Effect.runSync(
        Effect.result(
          Schema.decodeUnknownEffect(variant.inputSchema, { onExcessProperty: 'error' })(input),
        ),
      )._tag

    expect(variant.inputJsonSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
    expect(decode({ id: 'injected' })).toBe('Failure')
    expect(decode([])).toBe('Failure')
    expect(decode('str')).toBe('Failure')
  })
})
