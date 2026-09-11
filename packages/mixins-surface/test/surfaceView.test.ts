import { describe, expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import { inertHtml } from 'foldkit/html'
import { Behavior, Style, type SlotAttributes } from 'foldkit-mixins'
import { Surface } from 'foldkit-surface'
import { SurfaceView } from '../src/index.js'
import { Message, TodoList, TodoSlots, type TodoMessage } from './fixture.js'

const h = inertHtml as unknown as HtmlBuilder<TodoMessage>

type ProjectedTodo = {
  readonly todos: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly selectedId: string | null
}

const tagOf = (attribute: SlotAttributes<TodoMessage>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

const classValue = (attributes: SlotAttributes<TodoMessage>): string | undefined => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === 'Class') {
      return (attribute as { readonly value: string }).value
    }
  }
  return undefined
}

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

  it('projects the root model through Surface.rootView', () => {
    let seen: unknown
    const view = SurfaceView.define(TodoList, TodoSlots, (model, slots, h) => {
      seen = model
      return h.ul(slots.root.attrs(), [])
    })
    const rootView = Surface.rootView(TodoList, undefined, SurfaceView.toRenderer(view))
    const root = { todos: [{ id: 'a', title: 'A' }], selectedId: 'a', secret: 's' }
    rootView(root, h as unknown as Parameters<typeof rootView>[1])
    expect(seen).toEqual({ todos: [{ id: 'a', title: 'A' }], selectedId: 'a' })
  })

  it('applies Style and a projected-input Behavior through the bridge', () => {
    let resolved: SlotAttributes<TodoMessage> = []
    const ArchiveWhenSelected = Behavior.forSlots(TodoSlots)<ProjectedTodo, TodoMessage>({
      root: Behavior.slot({
        attributes: ({ input, h }) => (input.selectedId === null ? [] : [h.AriaDisabled(true)]),
      }),
    })
    const TodoCard = SurfaceView.define(TodoList, TodoSlots, (_model, slots, h) => {
      resolved = slots.root.attrs()
      return h.ul(resolved, [])
    }).pipe(
      Style.attach(Style.forSlots(TodoSlots)({ root: Style.class('todo-list') })),
      Behavior.attach(ArchiveWhenSelected),
    )
    const rootView = Surface.rootView(TodoList, undefined, SurfaceView.toRenderer(TodoCard))
    rootView(
      { todos: [], selectedId: 'a', secret: 's' },
      h as unknown as Parameters<typeof rootView>[1],
    )
    expect(classValue(resolved)).toBe('todo-list')
    expect(resolved.map(tagOf)).toContain('AriaDisabled')
  })
})
