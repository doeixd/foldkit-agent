import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { Projection, Surface } from 'foldkit-surface'

export const Model = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  selectedId: Schema.NullOr(Schema.String),
  secret: Schema.String,
})

export const Message = defineMessageUnion({
  SelectedTodo: { id: Schema.String },
  ArchivedTodo: { id: Schema.String },
  ClearedSecret: {},
})

export const App = Surface.make({ Model, Message })

/** The Message subset the `TodoList` Surface exposes. */
export type TodoMessage = typeof Message.SelectedTodo.Type | typeof Message.ArchivedTodo.Type

/** A Surface that projects two fields and exposes two of the three Messages. */
export const TodoList = Surface.define(App, 'TodoList', {
  model: ({ model }) => Projection.struct({ todos: model.todos, selectedId: model.selectedId }),
  messages: [Message.SelectedTodo, Message.ArchivedTodo],
})

export const TodoSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  archive: Slot.make({ capability: Capability.Interactive, events: [Event.Click] }),
})
