/**
 * The local-first contract, derived from the application.
 *
 * Nothing here restates behaviour. `forApplication(App)` reads the Model and
 * Message schemas, the initial Model, and `update` from `surface.ts`, and the
 * fragments below say only *which* fields replicate and *which* Messages change
 * them. Replay is the application's `update` on the shared slice, and it is
 * guarded: a durable Message that returns a Command or touches a local field is
 * refused at `submit` with a `ReplayError`, so a mistake fails on the first
 * edit rather than diverging replicas later.
 *
 * Two features contribute to one document as fragments. `compose` merges their
 * projections and Message sets and refuses a field declared twice with a
 * different codec, a Message declared durable twice, or a fragment from another
 * application.
 *
 * `authorize` is policy on the contract, per durable variant: `message` is
 * exactly that variant, `shared` is the authoritative snapshot, `principal` is
 * what the server's transport established. `journalContract()` carries the
 * compiled rules in the shape `makeJournal` takes, so `journal.ts` applies them
 * by spreading the contract. The client never runs them (a replica has no
 * principal); a refused operation comes back as a rejection and the replica
 * reverts it.
 */
import type { Document, HtmlBuilder } from 'foldkit/html'
import { MessageSet, type Contract } from 'foldkit-surface'
import {
  documentId,
  forApplication,
  mount,
  type Mounted,
  type Operation,
  type PolicyJournalContract,
  type Replica,
  type ReplicaError,
  type Sync as SyncContract,
} from 'foldkit-sync'
import { Message, type Model, type Shared } from './app.js'
import { isOwner, type SyncPrincipal } from './principal.js'
import { App, ListMeta, Todos } from './surface.js'

const TodoApp = forApplication(App).withPrincipal<SyncPrincipal>()

/** The list: the todos and every Message that changes them. */
export const TodosFragment = TodoApp.fragment({
  shared: Todos,
  durable: MessageSet.make(App, [
    Message.SubmittedTodo,
    Message.ToggledTodo,
    Message.RenamedTodo,
    Message.PrioritySet,
    Message.DeletedTodo,
    Message.ClearedCompleted,
  ]),
})

/** The list's own metadata, a separate feature sharing the document. */
export const ListMetaFragment = TodoApp.fragment({
  shared: ListMeta,
  durable: MessageSet.make(App, [Message.RenamedList]),
})

const TodoSync = TodoApp.make({
  documentId: documentId('todos'),
  ...TodoApp.compose(TodosFragment, ListMetaFragment),
  authorize: {
    // Destructive, list-wide operations are the owner's. `principal` is typed
    // from `withPrincipal`, so a rule cannot read a field the transport does
    // not establish.
    ClearedCompleted: ({ principal }) => isOwner(principal),
    RenamedList: ({ principal }) => isOwner(principal),
    // A delete must name a todo the authoritative snapshot still holds.
    // `message` is exactly `DeletedTodo` here; `message.title` would not compile.
    DeletedTodo: ({ message, shared }) => shared.todos.some(todo => todo.id === message.id),
  },
})

/**
 * The exports below are annotated because this example emits declarations and
 * the contract's inferred type expands a Foldkit-private alias that declaration
 * emit cannot name. Each is the same value, seen through a nameable type.
 */
export const Sync: SyncContract<Message, Shared> = TodoSync

/** For `Module`: this contract owns `todos` and `listTitle` and records the durable tags. */
export const contract: Contract = TodoSync.contract

/** The journal's codecs, reducer, and the compiled `authorize`, for `makeJournal`. */
export const journalContract = (): PolicyJournalContract<Operation, Shared, SyncPrincipal> =>
  TodoSync.journalContract()

/**
 * Runs the application over an open replica with `Sync.mount`: one reducer, a
 * durable Message applied at once and persisted after, the shared slice
 * re-installed when an exchange or a rejection moves the replica.
 */
export const mountTodos = (
  replica: Replica<Message, Shared>,
  options: {
    readonly container: HTMLElement
    readonly view: (model: Model, h: HtmlBuilder<Message>) => Document
    readonly onPersistenceFailure?: (model: Model, error: ReplicaError) => Model
  },
): Mounted<Model, Message> => mount(App, TodoSync, { replica, ...options })
