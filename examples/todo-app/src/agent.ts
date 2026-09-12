/**
 * The agent contract: what an agent may see, and what an agent may do.
 *
 * Nothing here reimplements application behaviour. Every capability is an
 * existing Message that `update` already handles, and the context is a Surface
 * projection over the same Model the human sees. WebMCP, MCP, and A2A are all
 * adapters over this one definition.
 */
import { Schema } from 'effect'
import { Agent } from 'foldkit-agent'
import { Message, Todo, counts } from './app.js'
import { AgentContext, App } from './surface.js'

/** Who is calling. A real app would resolve this from a session. */
export interface Principal {
  readonly actorId: string
}

const TodoAgent = Agent.forApplication<Principal>()(App)

export const AppAgent = TodoAgent.define({
  context: AgentContext,

  messages: TodoAgent.expose(Message, {
    // The id is ours, not the caller's: the agent supplies a title and the
    // Message is built here, so a caller cannot collide or forge an id.
    SubmittedTodo: {
      name: 'add_todo',
      description: 'Add a todo with the given title',
      input: Schema.Struct({ title: Schema.String }),
      toMessage: ({ title }) => ({ id: crypto.randomUUID(), title }),
    },

    // These take the caller's target directly.
    ToggledTodo: { name: 'toggle_todo', description: 'Mark a todo complete, or undo that' },
    RenamedTodo: { name: 'rename_todo', description: 'Rename an existing todo' },
    DeletedTodo: { name: 'delete_todo', description: 'Delete a todo' },
    ClearedCompleted: { name: 'clear_completed', description: 'Delete every completed todo' },
  }),

  resources: [
    Agent.resource('todos', {
      description: "The user's current todos",
      schema: Schema.Array(Todo),
      read: model => model.todos,
    }),
    Agent.resource('counts', {
      description: 'How many todos are active and completed',
      schema: Schema.Struct({
        total: Schema.Number,
        active: Schema.Number,
        completed: Schema.Number,
      }),
      read: model => counts(model),
    }),
  ],
})

export const bindAgent = TodoAgent.bind
