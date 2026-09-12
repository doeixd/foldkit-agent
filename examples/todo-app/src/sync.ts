/**
 * The local-first contract for the todo document.
 *
 * `Sync.forApplication` derives the shared projection, the durable subset, the
 * initial snapshot, and replay from the one `Surface.application` above:
 *
 * - `shared`  — the field set replicas agree on.
 * - `durable` — which Messages change that set.
 *
 * Annotated with the low-level `Sync` type because this example emits
 * declarations: the inferred type expands a Foldkit-private alias that
 * declaration emit cannot name.
 */
import { Surface } from 'foldkit-surface'
import { documentId, forApplication, type Sync as SyncContract } from 'foldkit-sync'
import { Message, type Shared } from './app.js'
import { App, Todos } from './surface.js'

export const Sync: SyncContract<Message, Shared> = forApplication(App, {
  documentId: documentId('todos'),
  shared: Todos,
  durable: Surface.messages(App, [
    Message.SubmittedTodo,
    Message.ToggledTodo,
    Message.RenamedTodo,
    Message.DeletedTodo,
    Message.ClearedCompleted,
  ]),
})
