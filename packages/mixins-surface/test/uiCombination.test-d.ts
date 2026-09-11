/**
 * Compile-time `@foldkit/ui` + Surface combination. Type-checked, not executed.
 */
import { view as buttonView } from '@foldkit/ui/button'
import { SurfaceView } from '../src/index.js'
import { Message, TodoList, TodoSlots, type TodoMessage } from './fixture.js'

SurfaceView.define(TodoList, TodoSlots, (model, slots, h) =>
  buttonView<TodoMessage>(
    {
      // @ts-expect-error ClearedSecret is not in the Surface's Message subset.
      onClick: Message.ClearedSecret(),
      toView: () => h.button([], []),
    },
    h,
  ),
)
