import { Agent } from '@foldkit/agent'
import { AgentNative, type DefineAction } from '@foldkit/agent-native'
import { Duration, Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  DeletedTodo: { id: Schema.String },
  FailedDeleteTodo: { id: Schema.String },
  ReceivedTodos: { count: Schema.Number },
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

const makeAgent = () => {
  const listeners = new Set<(message: Message) => void>()
  emit = message => {
    for (const listener of [...listeners]) listener(message)
  }

  return TodoAgent.bind({
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
  })
}

const actionsFor = () => AgentNative.actions({ agent: makeAgent() })

const named = (name: string) => {
  const action = actionsFor().find(candidate => candidate.name === name)
  if (action === undefined) throw new Error(`No action named ${name}`)
  return action
}

beforeEach(() => {
  model = emptyModel
  dispatched = []
  principal = { canDelete: true }
})

describe('compiling a contract into actions', () => {
  it('produces one action per exposed capability', () => {
    expect(actionsFor().map(action => action.name)).toEqual(['create_todo', 'delete_todo'])
  })

  it('carries the description from the contract', () => {
    expect(named('create_todo').description).toBe('Create a todo')
  })

  it('never invents an action for an unexposed Message', () => {
    expect(actionsFor().map(action => action.name)).not.toContain('deleted_todo')
    expect(actionsFor().map(action => action.name)).not.toContain('received_todos')
  })
})

describe('the schema bridge', () => {
  it('is a Standard Schema, which Zod also implements', () => {
    const standard = named('create_todo').schema['~standard']

    expect(standard.version).toBe(1)
    expect(standard.vendor).toBe('effect')
  })

  it('accepts input the contract accepts', async () => {
    const result = await named('create_todo').schema['~standard'].validate({ title: 'x' })

    expect(result.issues).toBeUndefined()
  })

  it('rejects input the contract rejects', async () => {
    const result = await named('create_todo').schema['~standard'].validate({ title: 42 })

    expect(result.issues?.length).toBeGreaterThan(0)
  })

  it('also offers the JSON Schema, for a consumer that builds its own validator', () => {
    expect(named('create_todo').jsonSchema).toMatchObject({
      type: 'object',
      required: ['title'],
    })
  })
})

describe('run', () => {
  it('only dispatches; it decides nothing itself', async () => {
    const result = await named('create_todo').run({ title: 'Write docs' })

    expect(result).toMatchObject({ ok: true, tag: 'RequestedCreateTodo' })
    expect(dispatched).toEqual([{ _tag: 'RequestedCreateTodo', title: 'Write docs' }])
  })

  it('still refuses what the contract refuses', async () => {
    model = { selectedTodoId: Option.some('a') }
    principal = { canDelete: false }

    const result = await named('delete_todo').run({ id: 'a' })

    // The action layer adds no authority of its own.
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Not authorized/)
    expect(dispatched).toEqual([])
  })

  it('still refuses input that fails the schema', async () => {
    const result = await named('create_todo').run({ title: 42 })

    expect(result.ok).toBe(false)
    expect(dispatched).toEqual([])
  })

  it('respects availability', async () => {
    const result = await named('delete_todo').run({ id: 'a' })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not available/)
  })

  it('reports a completion when the capability declares one', async () => {
    model = { selectedTodoId: Option.some('a') }
    const action = named('delete_todo')

    const pending = action.run({ id: 'a' })
    await new Promise(resolve => setTimeout(resolve, 0))
    emit(Message.DeletedTodo({ id: 'a' }))

    expect(await pending).toMatchObject({ ok: true, completion: 'completed' })
  })

  it('reports a declared failure as not ok', async () => {
    model = { selectedTodoId: Option.some('a') }
    const action = named('delete_todo')

    const pending = action.run({ id: 'a' })
    await new Promise(resolve => setTimeout(resolve, 0))
    emit(Message.FailedDeleteTodo({ id: 'a' }))

    expect(await pending).toMatchObject({ ok: false, completion: 'failed' })
  })
})

describe('register', () => {
  /** Stands in for the framework, with the shape its docs describe. */
  const stub = () => {
    const defined: Array<{ description: string; schema: unknown; run: unknown }> = []
    const defineAction: DefineAction = definition => {
      defined.push(definition as never)
      return definition
    }
    return { defined, defineAction }
  }

  it('defines one action per capability', () => {
    const { defined, defineAction } = stub()
    AgentNative.register({ agent: makeAgent(), defineAction })

    expect(defined.map(action => action.description)).toEqual([
      'Create a todo',
      'Delete the selected todo',
    ])
  })

  it('hands the framework a schema and a run it can call', async () => {
    const { defined, defineAction } = stub()
    AgentNative.register({ agent: makeAgent(), defineAction })

    // The framework validates with this, so it has to arrive intact.
    const schema = defined[0]?.schema as { '~standard': { version: number; vendor: string } }
    expect(schema['~standard']).toMatchObject({ version: 1, vendor: 'effect' })

    const run = defined[0]?.run as (input: unknown) => Promise<{ ok: boolean }>
    expect(await run({ title: 'x' })).toMatchObject({ ok: true })
    expect(dispatched).toHaveLength(1)
  })
})
