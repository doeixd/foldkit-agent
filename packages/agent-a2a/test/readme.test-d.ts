/**
 * The usage examples from this package's README, type-checked so the
 * documentation cannot drift from the API.
 */
import { Agent } from 'foldkit-agent'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { AgentA2a } from '../src/index.js'
import type { Message as A2aMessage } from '../src/index.js'

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
})

type Message = typeof Message.Type

interface Model {
  readonly selectedTodoId: Option.Option<string>
}

const TodoAgent = Agent.forModel<Model>()

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

const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: { model: currentModel, dispatch: sendToRuntime },
})

// The Agent Card.
export const card = AgentA2a.agentCard(AppAgent, {
  name: 'Todos',
  description: 'A todo list',
  url: 'https://todos.example/a2a',
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  security: [{ bearer: [] }],
})

const path: string = AgentA2a.AGENT_CARD_PATH

void path

// Calling a skill. `handle` takes an unknown message, so the wire shape the
// README shows is pinned against the schema the handler decodes with.
const served = AgentA2a.handler({ agent: agentRuntime })

await served.handle({
  jsonrpc: '2.0',
  id: 1,
  method: 'message/send',
  params: {
    message: {
      kind: 'message',
      role: 'user',
      messageId: 'm-1',
      parts: [{ kind: 'data', data: { skill: 'delete_todo', input: { id: 'todo-1' } } }],
    } satisfies A2aMessage,
  },
})
