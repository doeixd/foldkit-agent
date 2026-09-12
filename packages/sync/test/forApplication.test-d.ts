/**
 * `Sync.forApplication(App).make` inference contract. Type-checked but not
 * executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { documentId, forApplication } from '../src/index.js'

const Model = Schema.Struct({
  todos: Schema.Array(Schema.String),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String },
  SelectedTodo: { id: Schema.String },
})
const initial = { todos: [], selectedTodoId: null }
const update = (model: typeof Model.Type, _message: typeof Message.Type) => ({ model })

const App = Surface.application({ Model, Message, initial, update })
const Todos = Surface.pick(App.fields.todos)
const Changes = Surface.messages(App, [Message.CreatedTodo])
const TodoSync = forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
})

// The projection exposes only the shared field, not the local `selectedTodoId`.
const _shared: { readonly todos: ReadonlyArray<string> } = TodoSync.projection.get(initial)

forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  // @ts-expect-error `durable` must be a `Surface.messages` subset, not a bare array
  durable: [Message.CreatedTodo],
})

// A custom `replay` sees only the declared subset and returns the shared shape.
forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
  replay: (value, message) => {
    const _tag: 'CreatedTodo' = message._tag
    return { todos: [...value.todos, message.id] }
  },
})

forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
  // @ts-expect-error `replay` must return the shared shape
  replay: value => ({ todos: value.todos.length }),
})

forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
  replay: (value, message) =>
    // @ts-expect-error `SelectedTodo` is not in the durable subset, so it never reaches replay
    message._tag === 'SelectedTodo' ? value : value,
})
