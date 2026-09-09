/**
 * Conformance against the official A2A JSON Schema, not against our own types.
 *
 * `a2a-v0.3.0.schema.json` is the specification's published schema, copied
 * verbatim from a2aproject/A2A at tag v0.3.0. Every expectation below is read
 * out of that file -- method names, required fields, enum members, error codes
 * -- so a test cannot agree with a mistake this package made.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Agent } from '@foldkit/agent'
import { AgentA2a } from '@foldkit/agent-a2a'
import type { Response } from '@foldkit/agent-a2a'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'

interface JsonSchema {
  readonly $ref?: string
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly type?: string | ReadonlyArray<string>
  readonly const?: unknown
  readonly enum?: ReadonlyArray<unknown>
  readonly required?: ReadonlyArray<string>
  readonly properties?: Record<string, JsonSchema>
  readonly items?: JsonSchema
  readonly default?: unknown
}

const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('./a2a-v0.3.0.schema.json', import.meta.url)), 'utf8'),
) as { readonly definitions: Record<string, JsonSchema> }

const definition_ = (name: string): JsonSchema => {
  const found = spec.definitions[name]
  if (found === undefined) throw new Error(`No such definition in the A2A schema: ${name}`)
  return found
}

/**
 * A validator for the subset of draft-07 this schema uses.
 *
 * It uses `$ref`, `anyOf`, `type`, `const`, `enum`, `required`, `properties`
 * and `items`, and no other keyword; the check below asserts that stays true.
 */
const errorsIn = (value: unknown, schema: JsonSchema, path: string): ReadonlyArray<string> => {
  if (schema.$ref !== undefined) {
    return errorsIn(value, definition_(schema.$ref.replace('#/definitions/', '')), path)
  }

  if (schema.anyOf !== undefined) {
    return schema.anyOf.some(branch => errorsIn(value, branch, path).length === 0)
      ? []
      : [`${path}: matched none of ${schema.anyOf.length} alternatives`]
  }

  const problems: Array<string> = []
  const kindOf = (candidate: unknown): string =>
    candidate === null
      ? 'null'
      : Array.isArray(candidate)
        ? 'array'
        : typeof candidate === 'number'
          ? Number.isInteger(candidate)
            ? 'integer'
            : 'number'
          : typeof candidate

  if (schema.type !== undefined) {
    const actual = kindOf(value)
    // `type` is a single name or a list of them.
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = allowed.some(name => name === actual || (name === 'number' && actual === 'integer'))
    if (!ok) problems.push(`${path}: expected ${allowed.join('|')}, got ${actual}`)
  }

  if ('const' in schema && value !== schema.const) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) problems.push(`${path}: missing required "${key}"`)
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (record[key] !== undefined)
        problems.push(...errorsIn(record[key], property, `${path}.${key}`))
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      problems.push(...errorsIn(item, schema.items!, `${path}[${index}]`)),
    )
  }

  return problems
}

const conformsTo = (value: unknown, name: string): void => {
  const problems = errorsIn(value, definition_(name), name)
  expect(problems, `${name}\n${JSON.stringify(value, null, 2)}`).toEqual([])
}

/** The literal the spec fixes for a request's `method`. */
const methodOf = (requestName: string): string => {
  const literal = definition_(requestName).properties?.['method']?.const
  if (typeof literal !== 'string') throw new Error(`${requestName} has no method const`)
  return literal
}

const errorCodeOf = (errorName: string): unknown =>
  definition_(errorName).properties?.['code']?.const

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
})

type Message = typeof Message.Type

interface Model {
  readonly selectedTodoId: Option.Option<string>
}

const TodoAgent = Agent.forModel<Model, { readonly canDelete: boolean }>()

const definition = TodoAgent.define({
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
      authorize: ({ principal }) => principal.canDelete,
    },
  }),
})

let ids: number

const makeHandler = () =>
  AgentA2a.handler({
    agent: TodoAgent.bind({
      definition,
      host: {
        model: () => ({ selectedTodoId: Option.none() }),
        dispatch: () => {},
        principal: () => ({ canDelete: true }),
        observe: () => () => {},
      },
    }),
    newId: () => `id-${ids++}`,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  })

/** A `message/send` request exactly as the spec's MessageSendParams describes it. */
const sendRequest = (skill: string, input: unknown) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: methodOf('SendMessageRequest'),
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'client-1',
      parts: [{ kind: 'data', data: { skill, input } }],
    },
  },
})

const card = () =>
  AgentA2a.agentCard(definition, {
    name: 'Todos',
    description: 'A todo list',
    url: 'https://todos.example/a2a',
  })

beforeEach(() => {
  ids = 0
})

describe('the schema this suite validates against', () => {
  it('uses only the keywords the validator implements', () => {
    const known = new Set([
      '$ref',
      'anyOf',
      'type',
      'const',
      'enum',
      'required',
      'properties',
      'items',
      'description',
      'default',
      'examples',
      'format',
      'additionalProperties',
      'title',
      'deprecated',
    ])

    const seen = new Set<string>()
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(walk)
      if (typeof node !== 'object' || node === null) return
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        seen.add(key)
        if (key !== 'properties' && key !== 'definitions') walk(child)
        else Object.values(child as Record<string, unknown>).forEach(walk)
      }
    }
    walk(spec.definitions)

    expect([...seen].filter(key => !known.has(key) && key.startsWith('$'))).toEqual([])
    expect(
      ['allOf', 'oneOf', 'not', 'if', 'patternProperties'].filter(key => seen.has(key)),
    ).toEqual([])
  })
})

describe('the Agent Card', () => {
  it('advertises the protocol version whose schema it conforms to', () => {
    // The schema's own declared version. Advertising anything else is a promise
    // the wire responses below do not keep.
    expect(card().protocolVersion).toBe(
      definition_('AgentCard').properties?.['protocolVersion']?.default,
    )
  })

  it('validates against the spec’s AgentCard', () => {
    conformsTo(card(), 'AgentCard')
  })

  it('binds its url to a transport the spec names', () => {
    expect(definition_('TransportProtocol').enum).toContain(card().preferredTransport)
    // The one this adapter actually serves.
    expect(card().preferredTransport).toBe('JSONRPC')
  })

  it('lists skills the spec would accept', () => {
    for (const skill of card().skills) conformsTo(skill, 'AgentSkill')
  })
})

describe('the method set', () => {
  it.each([
    [
      'SendMessageRequest',
      { message: { kind: 'message', role: 'user', messageId: 'm', parts: [] } },
    ],
    ['GetTaskRequest', { id: 'nope' }],
    ['CancelTaskRequest', { id: 'nope' }],
  ])('answers %s under the name the spec fixes', async (requestName, params) => {
    const served = makeHandler()
    const response = await served.handle({
      jsonrpc: '2.0',
      id: 1,
      method: methodOf(requestName),
      params,
    })

    const error = response !== undefined && 'error' in response ? response.error : undefined
    expect(error?.code).not.toBe(errorCodeOf('MethodNotFoundError'))
  })

  it('refuses a method the spec does not define', async () => {
    const served = makeHandler()
    const response = await served.handle({ jsonrpc: '2.0', id: 1, method: 'SendMessage' })

    conformsTo(response, 'JSONRPCErrorResponse')
    expect((response as { error: { code: number } }).error.code).toBe(
      errorCodeOf('MethodNotFoundError'),
    )
  })
})

describe('wire responses', () => {
  const resultOf = (response: Response | undefined): unknown =>
    response !== undefined && 'result' in response ? response.result : undefined

  it('answers message/send with a spec-shaped success response', async () => {
    const served = makeHandler()
    const response = await served.handle(sendRequest('create_todo', { title: 'Write docs' }))

    conformsTo(response, 'SendMessageSuccessResponse')
  })

  it('answers a refused skill with a spec-shaped success response too', async () => {
    // A rejected task is still a Task: refusal is task state, not a JSON-RPC error.
    const served = makeHandler()
    const response = await served.handle(sendRequest('delete_todo', { id: 'a' }))

    conformsTo(response, 'SendMessageSuccessResponse')
  })

  it('reports task state in the spec’s vocabulary', async () => {
    const served = makeHandler()
    const completed = resultOf(await served.handle(sendRequest('create_todo', { title: 'x' })))
    const rejected = resultOf(await served.handle(sendRequest('delete_todo', { id: 'a' })))

    const states = definition_('TaskState').enum ?? []
    for (const task of [completed, rejected]) {
      expect(states).toContain((task as { status: { state: string } }).status.state)
    }
  })

  it('answers tasks/get with the same task, still spec-shaped', async () => {
    const served = makeHandler()
    const sent = resultOf(await served.handle(sendRequest('create_todo', { title: 'x' })))
    const id = (sent as { id: string }).id

    const response = await served.handle({
      jsonrpc: '2.0',
      id: 2,
      method: methodOf('GetTaskRequest'),
      params: { id },
    })

    conformsTo(response, 'GetTaskSuccessResponse')
    expect((resultOf(response) as { id: string }).id).toBe(id)
  })

  it('answers tasks/cancel with a spec-shaped task', async () => {
    const served = makeHandler()
    const sent = resultOf(await served.handle(sendRequest('create_todo', { title: 'x' })))

    const response = await served.handle({
      jsonrpc: '2.0',
      id: 3,
      method: methodOf('CancelTaskRequest'),
      params: { id: (sent as { id: string }).id },
    })

    conformsTo(response, 'CancelTaskSuccessResponse')
  })

  it('uses the spec’s code for an unknown task', async () => {
    const served = makeHandler()
    const response = await served.handle({
      jsonrpc: '2.0',
      id: 4,
      method: methodOf('GetTaskRequest'),
      params: { id: 'not-a-task' },
    })

    conformsTo(response, 'JSONRPCErrorResponse')
    expect((response as { error: { code: number } }).error.code).toBe(
      errorCodeOf('TaskNotFoundError'),
    )
  })

  it('uses the spec’s code for params it cannot read', async () => {
    const served = makeHandler()
    const response = await served.handle({
      jsonrpc: '2.0',
      id: 5,
      method: methodOf('SendMessageRequest'),
      params: { message: { role: 'user' } },
    })

    conformsTo(response, 'JSONRPCErrorResponse')
    expect((response as { error: { code: number } }).error.code).toBe(
      errorCodeOf('InvalidParamsError'),
    )
  })
})
