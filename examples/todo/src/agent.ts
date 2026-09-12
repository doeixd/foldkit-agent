import { Agent } from 'foldkit-agent'
import { Surface } from 'foldkit-surface'
import { Option, Schema } from 'effect'
import { Message, Model, Todo, initialModel, update } from './app.js'

/** Who is calling. A real app would resolve this from a session. */
export interface Principal {
  readonly canDelete: boolean
}

const App = Surface.application({
  Model,
  Message,
  initial: initialModel,
  update: (model, message) => ({ model: update(model, message) }),
})

const TodoAgent = Agent.forApplication<Principal>()(App)

/**
 * The agent contract: what an agent may see, and what an agent may do.
 *
 * Nothing here reimplements application behaviour. Every capability is an
 * existing Message that `update` already knows how to handle.
 */
export const AppAgent = TodoAgent.make({
  // What an agent may see. `lastError` is deliberately not projected.
  context: Surface.pick(App.fields.todos, App.fields.selectedTodoId),

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

    // A contextual capability: it takes its target from the Model rather than
    // from the caller. `rename_todo` above is the explicit form, naming the todo
    // it acts on; this one cannot act on anything but the current selection, so
    // an agent has no id to get wrong.
    RequestedDeleteTodo: {
      name: 'delete_selected_todo',
      description: 'Delete the currently selected todo',

      // Availability is not a hint: without a selection this capability is
      // neither advertised nor invocable, which is what makes the empty input
      // safe to resolve below.
      available: model => Option.isSome(model.selectedTodoId),

      input: Schema.Struct({}),
      toMessage: (_, { model }) => ({ id: Option.getOrThrow(model.selectedTodoId) }),

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
