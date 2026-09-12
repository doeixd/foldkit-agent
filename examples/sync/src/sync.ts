import { Surface } from 'foldkit-surface'
import { documentId, forApplication, type Sync as SyncContract } from 'foldkit-sync'
import { Message, Model, initialModel, update, type Shared } from './app.js'

const App = Surface.application({ Model, Message, initial: initialModel, update })

const Todos = Surface.pick(App.fields.todos)
const TodoChanges = Surface.messages(App, [
  Message.CreatedTodo,
  Message.RenamedTodo,
  Message.DeletedTodo,
])

/**
 * The replicated-state contract for the todo document: `Sync.forApplication`
 * derives the shared projection, the durable subset, the initial snapshot, and
 * replay from one application declaration.
 *
 * Annotated with the low-level `Sync` type because this example emits
 * declarations: the inferred type contains `Schema.Schema.Type<MessageUnion<...>>`,
 * which expands a Foldkit-private alias that declaration emit cannot name.
 */
export const Sync: SyncContract<Message, Shared> = forApplication(App).define({
  documentId: documentId('todos'),
  shared: Todos,
  durable: TodoChanges,
})
