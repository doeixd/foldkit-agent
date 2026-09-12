/**
 * The agent contract: what an agent may see, and what an agent may do.
 *
 * Nothing here reimplements behaviour. Every capability is a Message that
 * `update` already handles, the context is the `Overview` Surface the view
 * could render, and WebMCP, MCP, and A2A are adapters over this one value.
 *
 * Three things to notice:
 *
 * - `add_todo` exposes `RequestedTodo`, the *intent*, not `SubmittedTodo`, the
 *   fact. The agent never mints an id or a timestamp; the Command does. Its
 *   `completion` contract says the call is done when the correlated
 *   `SubmittedTodo` is applied, so `dispatch` resolves with the fact.
 * - `clear_completed` and `rename_list` carry the same `authorize` rule the
 *   sync contract applies on the server. The agent is refused here, early and
 *   typed; the journal would refuse it anyway, late.
 * - The context is a Surface. The same value could be rendered.
 */
import { Schema } from 'effect'
import { Agent } from 'foldkit-agent'
import { Message, Todo, counts } from './app.js'
import { isOwner, type Principal } from './principal.js'
import { App, Overview } from './surface.js'

const TodoAgent = Agent.forApplication(App).withPrincipal<Principal>()

export const AppAgent = TodoAgent.make({
  name: 'assistant',
  context: Overview,

  messages: TodoAgent.expose(Message, {
    RequestedTodo: Agent.variant({
      name: 'add_todo',
      description: 'Add a todo with the given title',
      // The external input is declared, decoded, and mapped onto the intent.
      // An agent supplies a title and nothing else; the id and the timestamp
      // are minted by the Command that `RequestedTodo` runs.
      input: Schema.Struct({ title: Schema.String }),
      toMessage: ({ title }) => ({ title }),
      completion: {
        success: Message.SubmittedTodo,
        // Two adds can be in flight; the fact that finishes this one carries its title.
        correlate: (request, result) => request.title.trim() === result.title,
      },
    }),

    ToggledTodo: { name: 'toggle_todo', description: 'Mark a todo done, or undo that' },
    RenamedTodo: { name: 'rename_todo', description: 'Rename an existing todo' },
    PrioritySet: { name: 'set_priority', description: 'Set a todo to low, normal, or high' },
    DeletedTodo: { name: 'delete_todo', description: 'Delete a todo' },

    ClearedCompleted: {
      name: 'clear_completed',
      description: 'Delete every completed todo (owner only)',
      authorize: ({ principal }) => isOwner(principal),
    },
    RenamedList: {
      name: 'rename_list',
      description: 'Rename the list (owner only)',
      authorize: ({ principal }) => isOwner(principal),
    },
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
