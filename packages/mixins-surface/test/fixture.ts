import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Capability, Event, Slot, Slots, type SlotAttributes } from 'foldkit-mixins'
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

export const App = Surface.application({ Model, Message })

/** The Message subset the `TodoList` Surface exposes. */
export type TodoMessage = typeof Message.SelectedTodo.Type | typeof Message.ArchivedTodo.Type

/** A Surface that projects two fields and exposes two of the three Messages. */
export const TodoList = Surface.make(App, 'TodoList', {
  model: ({ model }) => Projection.struct({ todos: model.todos, selectedId: model.selectedId }),
  messages: [Message.SelectedTodo, Message.ArchivedTodo],
})

export const TodoSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  archive: Slot.make({ capability: Capability.Interactive, events: [Event.Click] }),
})

export const tagOf = <Message>(attribute: SlotAttributes<Message>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

export const attributeOf = <Message>(
  attributes: SlotAttributes<Message>,
  tag: string,
): Record<string, unknown> | undefined => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === tag) return attribute as Record<string, unknown>
  }
  return undefined
}

export const classValue = <Message>(attributes: SlotAttributes<Message>): string | undefined => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === 'Class') return (attribute as { readonly value: string }).value
  }
  return undefined
}
