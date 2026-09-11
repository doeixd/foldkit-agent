/**
 * `Sync.make` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { documentId, make, project } from '../src/index.js'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
const ModelSchema = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  SelectedTodo: { id: Schema.String },
})
const App = Surface.make({ Model: ModelSchema, Message })
const initial = { todos: [], selectedTodoId: null }

const TodoSync = make(App, 'TodoSync', {
  documentId: documentId('todos'),
  initial,
  model: project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo],
  replay: shared => shared,
})

// The projection exposes only the shared field, not the local `selectedTodoId`.
const _shared: {
  readonly todos: ReadonlyArray<{ readonly id: string; readonly title: string }>
} = TodoSync.projection.get(initial)

// `replay` sees only the declared subset, so `SelectedTodo` is not in its union.
const Other = defineMessageUnion({ Ping: {} })

make(App, 'BadMessages', {
  documentId: documentId('todos'),
  initial,
  model: project({ todos: App.model.todos }),
  // @ts-expect-error `Ping` is not a variant of App's Message union
  messages: [Other.Ping],
  replay: shared => shared,
})

make(App, 'BadInitial', {
  documentId: documentId('todos'),
  // @ts-expect-error `initial` must be the full app Model, including local fields
  initial: { todos: [] },
  model: project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo],
  replay: shared => shared,
})
