import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

/** The application half of the example: an ordinary Foldkit Model and Message union. */

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

export type Todo = typeof Todo.Type

export const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.Option(Schema.String),
  lastError: Schema.Option(Schema.String),
})

export type Model = typeof Model.Type

/**
 * Semantic, surface-independent Messages.
 *
 * `RequestedDeleteTodo` rather than `ClickedDeleteButton`, so a button and an
 * agent can originate the same transition.
 */
export const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedRenameTodo: { id: Schema.String, title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  RequestedToggleTodo: { id: Schema.String },
  SelectedTodo: { id: Schema.String },
  ClearedSelection: {},

  // Internal. Never exposed: an agent has no business originating these.
  ReceivedTodos: { todos: Schema.Array(Todo) },
  FailedToLoadTodos: { message: Schema.String },
})

export type Message = typeof Message.Type

export const initialModel: Model = {
  todos: [],
  selectedTodoId: Option.none(),
  lastError: Option.none(),
}

let nextId = 1

/**
 * The state transition function.
 *
 * A real Foldkit `update` returns Commands alongside the Model; this stand-in
 * returns only the Model, because what the example demonstrates is the agent
 * layer above it. Nothing else here changes.
 */
export const update = (model: Model, message: Message): Model =>
  Message.match(message, {
    RequestedCreateTodo: ({ title }) => ({
      ...model,
      todos: [...model.todos, { id: `todo-${nextId++}`, title, completed: false }],
    }),

    RequestedRenameTodo: ({ id, title }) => ({
      ...model,
      todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
    }),

    RequestedDeleteTodo: ({ id }) => ({
      ...model,
      todos: model.todos.filter(todo => todo.id !== id),
      selectedTodoId: Option.filter(model.selectedTodoId, selected => selected !== id),
    }),

    RequestedToggleTodo: ({ id }) => ({
      ...model,
      todos: model.todos.map(todo =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo,
      ),
    }),

    SelectedTodo: ({ id }) => ({ ...model, selectedTodoId: Option.some(id) }),

    ClearedSelection: () => ({ ...model, selectedTodoId: Option.none() }),

    ReceivedTodos: ({ todos }) => ({ ...model, todos }),

    FailedToLoadTodos: ({ message }) => ({ ...model, lastError: Option.some(message) }),
  })

/** Resets the id counter, so a demo run is reproducible. */
export const resetIds = (): void => {
  nextId = 1
}
