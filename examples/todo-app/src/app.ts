/**
 * The one application, shared by every producer.
 *
 * `update` is the single source of truth: the human clicking a checkbox, an
 * agent calling a WebMCP tool, and a peer's operation arriving over sync all
 * become a `Message` and run through this function. Everything else in the
 * example — the Surface projections, the sync slice, the agent contract — is
 * derived from what is declared here.
 *
 * Durable Messages are state-only and carry every nondeterministic input (the
 * id), so replaying a committed operation is a pure function of the shared
 * slice. `replay` enforces that at the boundary.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'

export const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})
export type Todo = typeof Todo.Type

/** The replicated slice: the part of the Model a document owns. */
export const Shared = Schema.Struct({ todos: Schema.Array(Todo) })
export type Shared = typeof Shared.Type
export const decodeShared = Schema.decodeUnknownSync(Shared, { onExcessProperty: 'error' })
export const encodeShared = Schema.encodeSync(Shared)

export const Filter = Schema.Union([
  Schema.Literal('all'),
  Schema.Literal('active'),
  Schema.Literal('completed'),
])
export type Filter = typeof Filter.Type

/** The whole app state: the shared slice plus per-device UI state. */
export const Model = Schema.Struct({
  ...Shared.fields,
  draft: Schema.String,
  filter: Filter,
  editingId: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  /** Local: the composer's text. */
  DraftChanged: { value: Schema.String },
  /** Durable: commit the draft as a todo. */
  SubmittedTodo: { id: Schema.String, title: Schema.String },
  /** Durable. */
  ToggledTodo: { id: Schema.String },
  /** Durable. */
  RenamedTodo: { id: Schema.String, title: Schema.String },
  /** Durable. */
  DeletedTodo: { id: Schema.String },
  /** Durable: drop every completed todo. */
  ClearedCompleted: {},
  /** Local. */
  FilterSelected: { filter: Filter },
  /** Local. */
  EditingStarted: { id: Schema.String },
  /** Local. */
  EditingStopped: {},
})
export type Message = typeof Message.Type

export const initialModel: Model = {
  todos: [],
  draft: '',
  filter: 'all',
  editingId: null,
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    DraftChanged: ({ value }) => ({ model: { ...model, draft: value } }),
    SubmittedTodo: ({ id, title }) =>
      title.trim() === ''
        ? { model }
        : {
            model: {
              ...model,
              draft: '',
              todos: model.todos.some(todo => todo.id === id)
                ? model.todos
                : [...model.todos, { id, title: title.trim(), completed: false }],
            },
          },
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
        editingId: model.editingId === id ? null : model.editingId,
        todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
      },
    }),
    DeletedTodo: ({ id }) => ({
      model: {
        ...model,
        editingId: model.editingId === id ? null : model.editingId,
        todos: model.todos.filter(todo => todo.id !== id),
      },
    }),
    ClearedCompleted: () => ({
      model: { ...model, todos: model.todos.filter(todo => !todo.completed) },
    }),
    FilterSelected: ({ filter }) => ({ model: { ...model, filter } }),
    EditingStarted: ({ id }) => ({ model: { ...model, editingId: id } }),
    EditingStopped: () => ({ model: { ...model, editingId: null } }),
  })

/** Which Messages change the replicated slice; the rest are per-device. */
export const durableTags = new Set<Message['_tag']>([
  'SubmittedTodo',
  'ToggledTodo',
  'RenamedTodo',
  'DeletedTodo',
  'ClearedCompleted',
])

export const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: 'error' })
export const encodeMessage = Schema.encodeSync(Message)

/**
 * Replays one committed operation against the replicated slice.
 *
 * It runs the real `update` and then proves the transition stayed inside the
 * shared slice: no Commands, and no change to `draft`/`filter`/`editingId`.
 * A durable Message that reaches for local state fails loudly here rather than
 * silently diverging across replicas.
 */
export const replay = (shared: Shared, message: Message, transition = update): Shared => {
  if (!durableTags.has(message._tag)) throw new Error('Message is local-only')
  const result = transition({ ...initialModel, ...shared }, message)
  if (result.commands?.length) throw new Error('Durable transitions must not produce Commands')
  const { todos, draft, filter, editingId } = result.model
  if (draft !== initialModel.draft || filter !== initialModel.filter || editingId !== null) {
    throw new Error('Durable transition changed local Model fields')
  }
  return decodeShared({ todos })
}

/** The todos visible under a filter, in insertion order. */
export const visibleTodos = (model: Model): ReadonlyArray<Todo> => {
  if (model.filter === 'all') return model.todos
  const wanted = model.filter === 'active' ? false : true
  return model.todos.filter(todo => todo.completed === wanted)
}

/** Counts for the footer and the agent context. */
export const counts = (
  model: Model,
): { readonly total: number; readonly active: number; readonly completed: number } => ({
  total: model.todos.length,
  active: model.todos.filter(todo => !todo.completed).length,
  completed: model.todos.filter(todo => todo.completed).length,
})
