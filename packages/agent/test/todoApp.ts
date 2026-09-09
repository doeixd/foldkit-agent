import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

/**
 * The example application from the README, used as the fixture for every test.
 */
export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

export const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.Option(Schema.String),
})

export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  RequestedCreateTodo: {
    title: Schema.String,
  },

  RequestedRenameTodo: {
    id: Schema.String,
    title: Schema.String,
  },

  RequestedDeleteTodo: {
    id: Schema.String,
  },

  ClearedSelection: {},

  ReceivedTodos: {
    todos: Schema.Array(Todo),
  },

  FailedToLoadTodos: {
    message: Schema.String,
  },
})

export type Message = typeof Message.Type

export const emptyModel: Model = {
  todos: [],
  selectedTodoId: Option.none(),
}

export const modelWith = (overrides: Partial<Model>): Model => ({ ...emptyModel, ...overrides })
