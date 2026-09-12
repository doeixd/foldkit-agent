import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Projection, Surface } from '../src/index.js'

export const TodoSchema = Schema.Struct({ id: Schema.String, title: Schema.String })

export const Model = Schema.Struct({
  todos: Schema.Array(TodoSchema),
  selectedTodoId: Schema.NullOr(Schema.String),
})

export const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  SelectedTodo: { id: Schema.String },
})

export const App = Surface.application({ Model, Message })

/** The Surface half of the canonical example in docs/design/REVISION_PLAN.md §11. */
export const TodoList = Surface.make(App, 'TodoList', {
  model: ({ model }) => Projection.struct({ todos: model.todos, selection: model.selectedTodoId }),
  messages: [Message.CreatedTodo, Message.RenamedTodo],
})
