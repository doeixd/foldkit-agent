import { describe, expect, it } from 'vitest'
import { view as buttonView } from '@foldkit/ui/button'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Style, type SlotAttributes } from 'foldkit-mixins'
import { Button, ButtonSlots } from 'foldkit-mixins-ui'
import { SurfaceView } from '../src/index.js'
import {
  attributeOf,
  classValue,
  Message,
  TodoList,
  TodoSlots,
  type TodoMessage,
} from './fixture.js'

const h = inertHtml as unknown as HtmlBuilder<TodoMessage>

describe('@foldkit/ui inside a SurfaceView', () => {
  it('renders a Button with a Surface Message and a Mixin', () => {
    let captured: SlotAttributes<TodoMessage> = []
    const ArchiveButton = SurfaceView.define(TodoList, TodoSlots, (model, slots, h) =>
      h.ul(slots.root.attrs(), [
        buttonView<TodoMessage>(
          {
            onClick: Message.ArchivedTodo({ id: model.selectedId ?? 'none' }),
            toView: attributes => {
              const resolved = Button.resolve(
                attributes,
                [Style.forSlots(ButtonSlots)({ button: Style.class('archive') }).mixin],
                { input: model, h },
              )
              captured = resolved.button
              return h.button(resolved.button, ['Archive'])
            },
          },
          h,
        ),
      ]),
    )
    ArchiveButton({ todos: [], selectedId: 'a' }, h)
    expect(attributeOf(captured, 'Type')?.value).toBe('button')
    expect(classValue(captured)).toBe('archive')
    expect(attributeOf(captured, 'OnClick')?.message).toEqual(Message.ArchivedTodo({ id: 'a' }))
  })
})
