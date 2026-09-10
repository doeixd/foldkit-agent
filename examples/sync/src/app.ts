import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String })
export const Shared = Schema.Struct({ todos: Schema.Array(Todo) })
export type Shared = typeof Shared.Type
export const decodeShared = Schema.decodeUnknownSync(Shared, { onExcessProperty: 'error' })
export const Model = Schema.Struct({
  ...Shared.fields,
  selectedTodoId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  CreatedTodo: { id: Schema.String, title: Schema.String },
  RenamedTodo: { id: Schema.String, title: Schema.String },
  DeletedTodo: { id: Schema.String },
  SelectedTodo: { id: Schema.String },
})
export type Message = typeof Message.Type
export const initialModel: Model = { todos: [], selectedTodoId: null, lastError: null }

// IDs and all other nondeterministic inputs come from the Message.
export const update = (model: Model, message: Message): Update.Return<Model, Message> => ({
  model: Message.match(message, {
    CreatedTodo: ({ id, title }) => ({
      ...model,
      todos: model.todos.some(todo => todo.id === id)
        ? model.todos
        : [...model.todos, { id, title }],
    }),
    RenamedTodo: ({ id, title }) => ({
      ...model,
      todos: model.todos.map(todo => (todo.id === id ? { ...todo, title } : todo)),
    }),
    DeletedTodo: ({ id }) => ({ ...model, todos: model.todos.filter(todo => todo.id !== id) }),
    SelectedTodo: ({ id }) => ({ ...model, selectedTodoId: id }),
  }),
})

export const durableTags = new Set<Message['_tag']>(['CreatedTodo', 'RenamedTodo', 'DeletedTodo'])
export const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: 'error' })
export const encodeMessage = Schema.encodeSync(Message)

/** Replays the application's update, refusing Commands and changes outside Shared. */
export const replay = (shared: Shared, message: Message, transition = update): Shared => {
  if (!durableTags.has(message._tag)) throw new Error('Message is local-only')
  const result = transition({ ...initialModel, ...shared }, message)
  if (result.commands?.length) throw new Error('Durable transitions must not produce Commands')
  const { todos, ...local } = result.model
  const { todos: _, ...initialLocal } = initialModel
  if (JSON.stringify(local) !== JSON.stringify(initialLocal)) {
    throw new Error('Durable transition changed local Model fields')
  }
  return decodeShared({ todos })
}
