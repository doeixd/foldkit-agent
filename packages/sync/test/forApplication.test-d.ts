/**
 * `Sync.forApplication(App).make` inference contract. Type-checked but not
 * executed.
 */
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { MessageSet, Projection, Surface } from 'foldkit-surface'
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
const Todos = Projection.pick(App.fields.todos)
const Changes = MessageSet.make(App, [Message.CreatedTodo])
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
  // @ts-expect-error `durable` must be a `MessageSet`, not a bare array
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

// --- fragments and authorization ------------------------------------------

const WideModel = Schema.Struct({
  todos: Schema.Array(Schema.String),
  members: Schema.Array(Schema.String),
  selectedTodoId: Schema.NullOr(Schema.String),
})
const WideMessage = defineMessageUnion({
  CreatedTodo: { id: Schema.String },
  Invited: { name: Schema.String },
  SelectedTodo: { id: Schema.String },
})
const Wide = Surface.application({
  Model: WideModel,
  Message: WideMessage,
  initial: { todos: [], members: [], selectedTodoId: null },
  update: (model: typeof WideModel.Type, _message: typeof WideMessage.Type) => ({ model }),
})
const WideSync = forApplication(Wide).withPrincipal<{ readonly role: 'admin' | 'guest' }>()
const TodosFragment = WideSync.fragment({
  shared: Projection.pick(Wide.fields.todos),
  durable: MessageSet.make(Wide, [WideMessage.CreatedTodo]),
})
const MembersFragment = WideSync.fragment({
  shared: Projection.pick(Wide.fields.members),
  durable: MessageSet.make(Wide, [WideMessage.Invited]),
})

const Composed = WideSync.make({
  documentId: documentId('wide'),
  ...WideSync.compose(TodosFragment, MembersFragment),
  // `replay` sees the union of both fragments' Messages.
  replay: (value, message) => {
    const _tag: 'CreatedTodo' | 'Invited' = message._tag
    return value
  },
  authorize: {
    // `message` is exactly this variant; `principal` is the fixed type.
    CreatedTodo: ({ principal, message, shared }) =>
      principal.role === 'admin' && !shared.todos.includes(message.id) && shared.members.length > 0,
  },
})
// The merged shared shape carries both fragments' fields and nothing local.
const _wide: {
  readonly todos: ReadonlyArray<string>
  readonly members: ReadonlyArray<string>
} = Composed.projection.get({ todos: [], members: [], selectedTodoId: null })

WideSync.make({
  documentId: documentId('wide'),
  ...WideSync.compose(TodosFragment),
  // @ts-expect-error `SelectedTodo` is not durable, so it has no rule
  authorize: { SelectedTodo: () => true },
})

WideSync.make({
  documentId: documentId('wide'),
  ...WideSync.compose(TodosFragment),
  // @ts-expect-error `CreatedTodo` has no `name`
  authorize: { CreatedTodo: ({ message }) => message.name === 'x' },
})

WideSync.make({
  documentId: documentId('wide'),
  ...WideSync.compose(TodosFragment),
  // @ts-expect-error the principal has no `owner`
  authorize: { CreatedTodo: ({ principal }) => principal.owner === 'x' },
})
