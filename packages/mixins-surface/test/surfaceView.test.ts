import { describe, expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Style } from 'foldkit-mixins'
import { SurfaceView } from '../src/index.js'
import { Message, TodoList, TodoSlots, type TodoMessage } from './fixture.js'

const h = inertHtml as unknown as HtmlBuilder<TodoMessage>

describe('SurfaceView', () => {
  it('names the view after the surface and renders the projected model', () => {
    const view = SurfaceView.define(TodoList, TodoSlots, (model, slots, h) =>
      h.ul(slots.root.attrs(), [h.li([], [model.selectedId ?? 'none'])]),
    )
    expect(view.name).toBe('TodoList')
    const html = view({ todos: [], selectedId: null }, h)
    expect(html).not.toBeNull()
  })

  it('accepts the core attach pipe', () => {
    const view = SurfaceView.define(TodoList, TodoSlots, (_model, slots, h) =>
      h.ul(slots.root.attrs(), []),
    )
    const Styled = view.pipe(
      Style.attach(Style.forSlots(TodoSlots)({ root: Style.class('todo-list') })),
    )
    expect(Styled.mixins).toHaveLength(1)
  })

  it('adapts to a Surface renderer', () => {
    const view = SurfaceView.define(TodoList, TodoSlots, (_model, slots, h) =>
      h.ul(slots.root.attrs(), []),
    )
    const renderer = SurfaceView.toRenderer(view)
    const html = renderer(
      { todos: [], selectedId: null },
      h as unknown as Parameters<typeof renderer>[1],
    )
    expect(html).not.toBeNull()
  })
})
