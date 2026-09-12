/**
 * The usage examples from this package's README, type-checked so the
 * documentation cannot drift from the API.
 */
import { Agent } from 'foldkit-agent'
import { Option, Schema } from 'effect'
import * as HttpEffect from 'effect/unstable/http/HttpEffect'
import { defineMessageUnion } from 'foldkit/message'
import { AgentMcp } from '../src/index.js'
import type { Notification } from '../src/index.js'

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

const AppAgent = TodoAgent.make({
  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: 'Create a todo',
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})

declare const currentModel: () => Model
declare const sendToRuntime: (message: Message) => void
declare const callerPrincipal: () => Principal

const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: { model: currentModel, dispatch: sendToRuntime, principal: callerPrincipal },
})

// Usage.
AgentMcp.stdio({ agent: agentRuntime })

declare const send: (notification: Notification) => void

const served = AgentMcp.handler({ agent: agentRuntime, onNotification: send })

await served.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

// Over HTTP.
declare const bindAgentFor: (principal: Principal) => typeof agentRuntime
declare const verify: (header: string | undefined) => Principal | undefined
declare const request: Request

const handler = HttpEffect.toWebHandler(
  AgentMcp.httpApp({
    authenticate: request => verify(request.headers['authorization']),
    createAgent: ({ principal }) => bindAgentFor(principal),
    allowedOrigins: ['https://app.example'],
  }),
)

export const response = await handler(request) // Request -> Response

const server = AgentMcp.httpHandler({
  authenticate: request => verify(request.headers['authorization']),
  createAgent: ({ principal }) => bindAgentFor(principal),
  allowedOrigins: ['https://app.example'],
})

declare const method: string
declare const headers: Readonly<Record<string, string | undefined>>
declare const body: unknown

export const handled = await server.handle({ method, headers, body })
