import { Surface } from 'foldkit-surface'
import { documentId, make, project, type Sync as SyncContract } from 'foldkit-sync'
import { Message, Model, initialModel, replay, type Shared } from './app.js'

const App = Surface.make({ Model, Message })

/**
 * The replicated-state contract for the todo document: `Sync.make` derives the
 * shared projection, the durable Message subset, and the initial snapshot from
 * the application, and exposes a read-only Surface over the same projection.
 *
 * Annotated with the low-level `Sync` type because this example emits
 * declarations: the inferred type contains `Schema.Schema.Type<MessageUnion<...>>`,
 * which expands a Foldkit-private alias that declaration emit cannot name.
 */
export const Sync: SyncContract<Message, Shared> = make(App, 'TodoSync', {
  documentId: documentId('todos'),
  initial: initialModel,
  model: project({ todos: App.model.todos }),
  messages: [Message.CreatedTodo, Message.RenamedTodo, Message.DeletedTodo],
  replay,
})
