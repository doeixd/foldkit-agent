import type { Document, HtmlBuilder } from 'foldkit/html'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
import {
  documentId,
  forApplication,
  mount,
  type Mounted,
  type Replica,
  type ReplicaError,
  type Sync as SyncContract,
} from 'foldkit-sync'
import { Message, Model, initialModel, update, type Shared } from './app.js'

const App = Surface.application({ Model, Message, initial: initialModel, update })

const Todos = Projection.pick(App.fields.todos)
const TodoChanges = MessageSet.make(App, [
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
const TodoSync = forApplication(App).make({
  documentId: documentId('todos'),
  shared: Todos,
  durable: TodoChanges,
})
export const Sync: SyncContract<Message, Shared> = TodoSync

/**
 * Runs the application over a replica with `Sync.mount`: one reducer, durable
 * Messages applied at once and persisted after, the shared slice re-installed
 * when an exchange or a failure changes it. Named here so the example can emit
 * declarations without naming the contract's inferred type.
 */
export const mountTodos = (
  replica: Replica<Message, Shared>,
  options: {
    readonly container: HTMLElement
    readonly view: (model: Model, h: HtmlBuilder<Message>) => Document
    readonly onPersistenceFailure?: (model: Model, error: ReplicaError) => Model
  },
): Mounted<Model, Message> => mount(App, TodoSync, { replica, ...options })
