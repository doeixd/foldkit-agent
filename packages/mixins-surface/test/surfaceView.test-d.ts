/**
 * Compile-time SurfaceView contract. Type-checked, not executed.
 */
import { Behavior, Event } from 'foldkit-mixins'
import { SurfaceView } from '../src/index.js'
import { Message, TodoList, TodoSlots } from './fixture.js'

const TodoView = SurfaceView.define(TodoList, TodoSlots, (model, slots, h) => {
  const _selected: string | null = model.selectedId
  const _title: string | undefined = model.todos[0]?.title
  void _selected
  void _title
  return h.ul(slots.root.attrs(), [h.li(slots.archive.attrs(), [])])
})
void TodoView

// A Behavior may emit a Message that belongs to the Surface's subset.
const Archiving = Behavior.forSlots(TodoSlots)<undefined, typeof Message.ArchivedTodo.Type>({
  archive: Behavior.slot({
    requires: { events: [Event.Click] },
    attributes: ({ h }) => [h.OnClick(Message.ArchivedTodo({ id: 'x' }))],
  }),
})
void Archiving

void SurfaceView.toRenderer(TodoView)

SurfaceView.define(TodoList, TodoSlots, (model, slots, h) =>
  // @ts-expect-error the projected Model does not expose the root-only `secret`.
  h.div(slots.root.attrs(), [model.secret]),
)

SurfaceView.define(TodoList, TodoSlots, (model, slots, h) =>
  // @ts-expect-error ClearedSecret is not in the Surface's Message subset.
  h.div(slots.root.attrs([h.OnClick(Message.ClearedSecret())]), []),
)
