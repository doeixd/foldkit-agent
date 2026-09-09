import { Agent } from 'foldkit-agent'
import { AgentMcp } from 'foldkit-agent-mcp'
import { PassThrough } from 'node:stream'
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { beforeEach, describe, expect, it } from 'vitest'

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
})

type Message = typeof Message.Type

interface Model {
  readonly todos: ReadonlyArray<string>
}

const TodoAgent = Agent.forModel<Model, Record<string, never>>()

const definition = TodoAgent.define({
  context: Agent.pick(Schema.Struct({ todos: Schema.Array(Schema.String) }), ['todos']),
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
  }),
})

let dispatched: Array<Message>

beforeEach(() => {
  dispatched = []
})

/** Real Node streams, so chunks arrive as Buffers the way stdin delivers them. */
const serve = () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: Array<string> = []
  let pending = ''
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      lines.push(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })

  const served = AgentMcp.stdio({
    agent: TodoAgent.bind({
      definition,
      host: {
        model: () => ({ todos: [] }),
        dispatch: (message: Message) => void dispatched.push(message),
        principal: () => ({}) as Record<string, never>,
      },
    }),
    input,
    output,
  })

  return { input, lines, served }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const line = (id: number, method: string, params?: Record<string, unknown>) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`

const callCreateTodo = (title: string) =>
  line(2, 'tools/call', { name: 'create_todo', arguments: { title } })

describe('stdio decoding', () => {
  it.for([
    { name: 'inside the two bytes of e-acute', title: 'café', inside: 'é' },
    { name: 'inside the four bytes of an emoji', title: 'party 🎉 time', inside: '🎉' },
    { name: 'on an ASCII boundary', title: 'plain ascii', inside: 'a' },
  ])('preserves a message split $name', async ({ title, inside }) => {
    const { input, lines } = serve()
    input.write(line(1, 'initialize'))
    await settle()

    const encoded = Buffer.from(callCreateTodo(title), 'utf8')
    // One byte into the character, so an incomplete sequence ends the first chunk.
    const split = encoded.indexOf(Buffer.from(inside, 'utf8')) + 1
    expect(split).toBeGreaterThan(0)
    input.write(encoded.subarray(0, split))
    input.write(encoded.subarray(split))
    await settle()

    expect(dispatched).toEqual([Message.RequestedCreateTodo({ title })])
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2 })
  })
})

describe('stdio close', () => {
  it('ignores input written after close', async () => {
    const { input, lines, served } = serve()
    input.write(line(1, 'initialize'))
    await settle()

    served.close()
    input.write(callCreateTodo('after close'))
    await settle()

    expect(dispatched).toEqual([])
    expect(lines).toHaveLength(1)
  })

  it('stays closed when the input ends and close is called again', async () => {
    const { input, served } = serve()
    input.write(line(1, 'initialize'))
    await settle()

    input.end()
    await settle()
    served.close()
    served.close()

    // The stream has ended, so deliver the chunk the way it would have arrived.
    input.emit('data', Buffer.from(callCreateTodo('after end'), 'utf8'))
    await settle()

    expect(dispatched).toEqual([])
  })
})
