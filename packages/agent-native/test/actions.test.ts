import { Agent } from 'foldkit-agent'
import { AgentNative } from 'foldkit-agent-native'
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

/** Resolved per invocation, as it would be from a request context. */
const actionsFor = () => AgentNative.actions({ definition, resolveRuntime: () => makeAgent() })

const named = (name: string) => {
  const action = actionsFor()[name]
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
    expect(Object.keys(actionsFor())).toEqual(['create_todo', 'delete_todo'])
  })

  it('carries the description from the contract', () => {
    expect(named('create_todo').tool.description).toBe('Create a todo')
  })

  it('advertises the derived parameters, which is what an agent reads', () => {
    expect(named('create_todo').tool.parameters).toMatchObject({
      type: 'object',
      required: ['title'],
    })
  })

  it('declares its HTTP method and that it needs an authenticated caller', () => {
    expect(named('create_todo').http).toEqual({ method: 'POST' })
    expect(named('create_todo').requiresAuth).toBe(true)
  })

  it('never claims to be read-only', () => {
    // Feeds plan-mode classification. Claiming read-only would have plan mode
    // run a capability for real, so every entry says write.
    for (const entry of Object.values(actionsFor())) {
      expect(entry.readOnly).toBe(false)
    }
  })

  it('never invents an action for an unexposed Message', () => {
    expect(Object.keys(actionsFor())).not.toContain('deleted_todo')
    expect(Object.keys(actionsFor())).not.toContain('received_todos')
  })
})

describe('the schema bridge', () => {
  it('is a Standard Schema, which Zod also implements', () => {
    const standard = named('create_todo').schema['~standard']

    expect(standard.version).toBe(1)
    expect(standard.vendor).toBe('effect')
  })

  it('carries validation and advertisement together', () => {
    // Agent Native needs both: `validate` to check input, `jsonSchema` to
    // advertise parameters. Neither Effect helper provides both on its own.
    const standard = named('create_todo').schema['~standard'] as unknown as Record<string, unknown>

    expect(typeof standard['validate']).toBe('function')
    expect(standard['jsonSchema']).toBeDefined()
  })

  it('accepts input the contract accepts', async () => {
    const result = await named('create_todo').schema['~standard'].validate({ title: 'x' })

    expect(result.issues).toBeUndefined()
  })

  it('rejects input the contract rejects', async () => {
    const result = await named('create_todo').schema['~standard'].validate({ title: 42 })

    expect(result.issues?.length).toBeGreaterThan(0)
  })

  it('carries its JSON Schema, which is where advertised parameters come from', () => {
    // defineAction reads ~standard.jsonSchema for the tool's parameters. A
    // validation-only Standard Schema is accepted and advertises nothing, so an
    // agent would see a tool that takes no input.
    const standard = named('create_todo').schema['~standard'] as unknown as {
      jsonSchema: { input: (options: { readonly target: string }) => Record<string, unknown> }
    }

    // A converter, not a document: this is what defineAction calls to build the
    // tool's parameters, and it describes the input side. Whether the framework
    // actually reads it is milestone 1's job -- these tests cannot see it.
    expect(typeof standard.jsonSchema.input).toBe('function')
    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({
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

describe('the registry', () => {
  it('is keyed by capability name, as registerPackageActions expects', () => {
    const registry = actionsFor()

    expect(Object.keys(registry).sort()).toEqual(['create_todo', 'delete_todo'])
    for (const entry of Object.values(registry)) {
      expect(typeof entry.run).toBe('function')
      expect(entry.tool.parameters).toBeDefined()
    }
  })

  it('resolves a Runtime per invocation, not once at registration', async () => {
    let resolved = 0
    const registry = AgentNative.actions({
      definition,
      resolveRuntime: () => {
        resolved += 1
        return makeAgent()
      },
    })

    expect(resolved).toBe(0)
    await registry['create_todo']!.run({ title: 'a' })
    await registry['create_todo']!.run({ title: 'b' })

    // Which Model a caller means depends on who is calling.
    expect(resolved).toBe(2)
  })

  it('passes the request context through to the resolver', async () => {
    const seen: Array<unknown> = []
    const registry = AgentNative.actions({
      definition,
      resolveRuntime: context => {
        seen.push(context)
        return makeAgent()
      },
    })

    await registry['create_todo']!.run({ title: 'x' }, { userEmail: 'alice@example.com' })

    expect(seen).toEqual([{ userEmail: 'alice@example.com' }])
  })
})

describe('when something throws', () => {
  const registryWith = (dispatch: () => void) =>
    AgentNative.actions({
      definition,
      resolveRuntime: () =>
        TodoAgent.bind({
          definition,
          host: {
            model: () => model,
            dispatch,
            principal: () => principal,
            observe: () => () => {},
          },
        }),
    })

  it('contains a host defect instead of leaking its text', async () => {
    const registry = registryWith(() => {
      throw new Error('connection to db-prod-1 failed: password=hunter2')
    })

    const result = await registry['create_todo']!.run({ title: 'x' })

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Capability "create_todo" failed unexpectedly')
    expect(result.message).not.toMatch(/hunter2|db-prod/)
  })

  it('lets a refusal from the resolver through, since the application chose it', async () => {
    const registry = AgentNative.actions({
      definition,
      resolveRuntime: () => {
        throw new Error('Unauthorized')
      },
    })

    // The framework surfaces this; reporting it as the capability failing would
    // hide an authentication problem behind a generic message.
    await expect(registry['create_todo']!.run({ title: 'x' })).rejects.toThrow('Unauthorized')
  })
})
