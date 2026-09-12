/**
 * The one application. Everything else in this example is derived from it.
 *
 * A human clicking a checkbox, an agent calling a tool, and a peer's committed
 * operation arriving over sync all become a `Message` and run through `update`.
 * There is no second reducer anywhere: the replica's replay, the server
 * journal's reducer, and the agent's dispatch are all this function.
 *
 * Three kinds of Message live here, and the distinction is the whole design:
 *
 * - **Durable facts** change the replicated slice (`todos`, `listTitle`). They
 *   must be state-only and deterministic, because the replica replays them and
 *   the server reduces them independently. Every nondeterministic input (an id,
 *   a timestamp) is *inside* the Message, never computed in `update`.
 *   `Sync.forApplication` enforces this: a durable Message whose transition
 *   returns a Command or touches a local field is refused at `submit`.
 * - **Effectful intents** are local Messages whose `update` returns a Command.
 *   The Command does the impure work (mint an id, read the clock) and emits the
 *   durable fact. `RequestedTodo` -> `SubmittedTodo` is the pattern.
 * - **Local Messages** change per-device UI state (draft, filter, editing) and
 *   never leave the tab.
 */
import { Clock, Effect, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'

export const Priority = Schema.Union([
  Schema.Literal('low'),
  Schema.Literal('normal'),
  Schema.Literal('high'),
])
export type Priority = typeof Priority.Type

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  priority: Priority,
  /** Milliseconds since the epoch, minted by the Command that created the todo. */
  createdAt: Schema.Number,
})
export type Todo = typeof Todo.Type

/**
 * The replicated slice. Two features contribute to it (`sync.ts` declares them
 * as fragments): the list itself, and the list's own metadata.
 */
export const Shared = Schema.Struct({
  listTitle: Schema.String,
  todos: Schema.Array(Todo),
})
export type Shared = typeof Shared.Type
export const encodeShared = Schema.encodeSync(Shared)

export const Filter = Schema.Union([
  Schema.Literal('all'),
  Schema.Literal('active'),
  Schema.Literal('completed'),
])
export type Filter = typeof Filter.Type

/** The whole Model: the shared slice plus per-device UI state. */
export const Model = Schema.Struct({
  ...Shared.fields,
  draft: Schema.String,
  filter: Filter,
  editingId: Schema.NullOr(Schema.String),
  editDraft: Schema.String,
  lastError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  // --- effectful intents: local, and their Command emits a durable fact -----
  /** The composer was submitted. The Command mints the id and the timestamp. */
  RequestedTodo: { title: Schema.String },
  /** The inline editor was committed. The Command emits `RenamedTodo`. */
  EditingCommitted: {},

  // --- durable facts: replicated, replayed, journaled ----------------------
  SubmittedTodo: { id: Schema.String, title: Schema.String, createdAt: Schema.Number },
  ToggledTodo: { id: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  PrioritySet: { id: Schema.String, priority: Priority },
  DeletedTodo: { id: Schema.String },
  ClearedCompleted: {},
  RenamedList: { title: Schema.String },

  // --- local: this device only ---------------------------------------------
  DraftChanged: { value: Schema.String },
  FilterSelected: { filter: Filter },
  EditingStarted: { id: Schema.String },
  EditDraftChanged: { value: Schema.String },
  EditingStopped: {},
})
export type Message = typeof Message.Type

export const initialModel: Model = {
  listTitle: 'Todos',
  todos: [],
  draft: '',
  filter: 'all',
  editingId: null,
  editDraft: '',
  lastError: null,
}

type Return = Update.Return<Model, Message>

/** Mints what a durable fact needs and cannot compute itself: an id and a time. */
const mintTodo = (title: string) => ({
  name: 'MintTodo',
  effect: Effect.map(Clock.currentTimeMillis, createdAt =>
    Message.SubmittedTodo({ id: crypto.randomUUID(), title, createdAt }),
  ),
})

const nextPriority: Record<Priority, Priority> = { low: 'normal', normal: 'high', high: 'low' }

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    // Intents. Note that each one clears its *local* state here, in the local
    // transition; the durable fact it causes never touches local fields.
    RequestedTodo: ({ title }) =>
      title.trim() === ''
        ? { model }
        : { model: { ...model, draft: '' }, commands: [mintTodo(title.trim())] },
    EditingCommitted: () => {
      const id = model.editingId
      const title = model.editDraft.trim()
      if (id === null) return { model }
      const stopped = { ...model, editingId: null, editDraft: '' }
      if (title === '' || model.todos.every(todo => todo.id !== id)) return { model: stopped }
      return {
        model: stopped,
        commands: [{ name: 'Rename', effect: Effect.succeed(Message.RenamedTodo({ id, title })) }],
      }
    },

    // Durable facts: pure over the shared slice, idempotent where a retry could
    // deliver one twice.
    SubmittedTodo: ({ id, title, createdAt }) => ({
      model: {
        ...model,
        todos: model.todos.some(todo => todo.id === id)
          ? model.todos
          : [...model.todos, { id, title, completed: false, priority: 'normal', createdAt }],
      },
    }),
    ToggledTodo: ({ id }) => ({
      model: {
        ...model,
        todos: model.todos.map(todo =>
          todo.id === id ? { ...todo, completed: !todo.completed } : todo,
        ),
      },
    }),
    RenamedTodo: ({ id, title }) => ({
      model: {
        ...model,
        todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
      },
    }),
    PrioritySet: ({ id, priority }) => ({
      model: {
        ...model,
        todos: model.todos.map(todo => (todo.id === id ? { ...todo, priority } : todo)),
      },
    }),
    DeletedTodo: ({ id }) => ({
      model: { ...model, todos: model.todos.filter(todo => todo.id !== id) },
    }),
    ClearedCompleted: () => ({
      model: { ...model, todos: model.todos.filter(todo => !todo.completed) },
    }),
    RenamedList: ({ title }) =>
      title.trim() === '' ? { model } : { model: { ...model, listTitle: title.trim() } },

    // Local.
    DraftChanged: ({ value }) => ({ model: { ...model, draft: value } }),
    FilterSelected: ({ filter }) => ({ model: { ...model, filter } }),
    EditingStarted: ({ id }) => ({
      model: {
        ...model,
        editingId: id,
        editDraft: model.todos.find(todo => todo.id === id)?.title ?? '',
      },
    }),
    EditDraftChanged: ({ value }) => ({ model: { ...model, editDraft: value } }),
    EditingStopped: () => ({ model: { ...model, editingId: null, editDraft: '' } }),
  })

/** The priority a click on the badge moves to. Derived, so the view stays dumb. */
export const bumpPriority = (priority: Priority): Priority => nextPriority[priority]

const rank: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

/** The todos under the filter, highest priority first, then oldest first. */
export const visibleTodos = (model: Pick<Model, 'todos' | 'filter'>): ReadonlyArray<Todo> => {
  const wanted = model.filter === 'all' ? undefined : model.filter === 'completed'
  return model.todos
    .filter(todo => wanted === undefined || todo.completed === wanted)
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt)
}

/** Counts for the header, the footer, and the agent. */
export const counts = (
  model: Pick<Model, 'todos'>,
): { readonly total: number; readonly active: number; readonly completed: number } => ({
  total: model.todos.length,
  active: model.todos.filter(todo => !todo.completed).length,
  completed: model.todos.filter(todo => todo.completed).length,
})
