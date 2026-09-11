/**
 * `Sync.forApplication` inference contract. Type-checked but not executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Surface } from 'foldkit-surface'
import { documentId, forApplication } from '../src/index.js'

const Model = Schema.Struct({ todos: Schema.Array(Schema.String) })
const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String },
  SelectedTodo: { id: Schema.String },
})
const initial = { todos: [] }
const update = (model: typeof Model.Type, _message: typeof Message.Type) => ({ model })

const App = Surface.application({ Model, Message, initial, update })
const Todos = Surface.pick(App.fields.todos)
const Changes = Surface.messages(App, [Message.CreatedTodo])

const _sync = forApplication(App, {
  documentId: documentId('todos'),
  shared: Todos,
  durable: Changes,
})

forApplication(App, {
  documentId: documentId('todos'),
  shared: Todos,
  // @ts-expect-error `durable` must be a `Surface.messages` subset, not a bare array
  durable: [Message.CreatedTodo],
})
