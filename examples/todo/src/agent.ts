import { Agent } from 'foldkit-agent'
import { Option, Schema } from 'effect'
import { Message, Model, Todo } from './app.js'

/** Who is calling. A real app would resolve this from a session. */
export interface Principal {
  readonly canDelete: boolean
}

const TodoAgent = Agent.forModel<Model, Principal>()

/**
 * The agent contract: what an agent may see, and what an agent may do.
 *
 * Nothing here reimplements application behaviour. Every capability is an
 * existing Message that `update` already knows how to handle.
 */
export const AppAgent = TodoAgent.define({
  // What an agent may see. `lastError` is deliberately not projected.
  context: Agent.pick(Model, ['todos', 'selectedTodoId']),

  messages: TodoAgent.expose(Message, {
    // Most capabilities need nothing but a description.
    RequestedCreateTodo: 'Create a new todo',
    RequestedToggleTodo: 'Mark a todo complete, or undo that',
    SelectedTodo: 'Select a todo, making the capabilities that act on one available',
    ClearedSelection: 'Clear the current selection',

    RequestedRenameTodo: {
      name: 'rename_todo',
      description: 'Rename an existing todo',
    },

    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',

      // Discoverability follows the Model: no selection, no capability.
      available: model => Option.isSome(model.selectedTodoId),

      // Authorization is a separate question from availability.
      authorize: ({ principal }) => principal.canDelete,
    },
  }),

  resources: [
    Agent.resource('todos', {
      description: "The user's current todos",
      schema: Schema.Array(Todo),
      read: (model: Model) => model.todos,
    }),
  ],
})

export const bindAgent = TodoAgent.bind
