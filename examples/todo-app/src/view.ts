/**
 * The views. Each one renders a Surface from `surface.ts` and publishes the
 * slots from `style.ts`; the styles and behaviors are attached, not written in.
 *
 * Read one view top to bottom and notice what is absent: no class names, no
 * inline style, no keyboard handling. `slots.x.attrs(base)` merges the base
 * attributes the view needs (a value, a Message) with everything attached to
 * that slot, through one resolver that refuses two owners of one event.
 *
 * The two form controls that carry real accessibility work (the checkbox and
 * the buttons) come from `@foldkit/ui`, which builds the attribute bundles and
 * hands them to `toView`; `foldkit-mixins-ui` resolves the attached styles
 * against the component's published contract.
 */
import * as UiButton from '@foldkit/ui/button'
import * as UiCheckbox from '@foldkit/ui/checkbox'
import type { Document, HtmlBuilder } from 'foldkit/html'
import { Behavior, SlotView, Style } from 'foldkit-mixins'
import { SurfaceView } from 'foldkit-mixins-surface'
import { Button as ButtonAdapter, Checkbox as CheckboxAdapter } from 'foldkit-mixins-ui'
import { Surface } from 'foldkit-surface'
import {
  Message,
  bumpPriority,
  counts,
  visibleTodos,
  type Filter,
  type Model,
  type Todo,
} from './app.js'
import {
  AddButtonStyle,
  ClearButtonStyle,
  ComposerSlots,
  ComposerStyle,
  EditorBehavior,
  FilterBehavior,
  FilterSlots,
  FilterStyle,
  FooterSlots,
  FooterStyle,
  HeaderSlots,
  HeaderStyle,
  ItemSlots,
  ItemStyle,
  PageSlots,
  PageStyle,
  ToggleStyle,
  type ItemInput,
} from './style.js'
import { Board, Composer, Footer, Header } from './surface.js'
import { Slots, Slot, Capability } from 'foldkit-mixins'

// --- header: the list title is editable in place --------------------------------

export const HeaderView = SurfaceView.define(Header, HeaderSlots, (model, slots, h) => {
  const tally = counts(model)
  return h.header(slots.root.attrs(), [
    h.input(
      slots.title.attrs([
        h.Type('text'),
        h.Value(model.listTitle),
        h.AriaLabel('List title'),
        // `change` fires on blur or Enter, so a rename is one durable fact, not
        // one per keystroke.
        h.OnChange(title => Message.RenamedList({ title })),
      ]),
    ),
    h.p(slots.tally.attrs(), [`${tally.active} active · ${tally.completed} completed`]),
  ])
}).pipe(Style.attach(HeaderStyle))

// --- composer: the only Surface that may cause `RequestedTodo` --------------------

export const ComposerView = SurfaceView.define(Composer, ComposerSlots, (model, slots, h) =>
  h.form(slots.root.attrs([h.OnSubmit(Message.RequestedTodo({ title: model.draft }))]), [
    h.input(
      slots.input.attrs([
        h.Type('text'),
        h.Placeholder('What needs doing?'),
        h.AriaLabel('New todo'),
        h.Value(model.draft),
        h.OnInput(value => Message.DraftChanged({ value })),
      ]),
    ),
    UiButton.view(
      {
        type: 'submit',
        isDisabled: model.draft.trim() === '',
        toView: attributes =>
          h.button(
            ButtonAdapter.resolve(attributes, [AddButtonStyle.mixin], { input: model, h }).button,
            ['Add'],
          ),
      },
      h,
    ),
  ]),
).pipe(Style.attach(ComposerStyle))

// --- board: filters and rows ---------------------------------------------------------

const BoardSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  filters: Slot.make({ capability: Capability.Container }),
  list: Slot.make({ capability: Capability.Collection }),
  empty: Slot.make({ capability: Capability.Container }),
})

const BoardStyle = Style.forSlots(BoardSlots)(
  {
    filters: Style.inline({ display: 'flex', gap: '0.35rem', margin: '1.25rem 0 0.5rem' }),
    list: Style.inline({ margin: '0', padding: '0', listStyle: 'none' }),
    empty: Style.inline({ margin: '0.5rem 0', color: 'var(--fk-color-muted)' }),
  },
  { name: 'BoardStyle' },
)

const filters: ReadonlyArray<Filter> = ['all', 'active', 'completed']
const filterMixins = [FilterStyle.mixin, FilterBehavior.mixin]
const itemMixins = [ItemStyle.mixin, EditorBehavior.mixin]

export const BoardView = SurfaceView.define(Board, BoardSlots, (model, slots, h) => {
  // Per-item slots: the same contract resolved once per filter and once per
  // row, each with its own input, so `Style.whenInput` sees the item.
  const filterButton = (filter: Filter) => {
    const item = SlotView.buildersFor(FilterSlots, filterMixins, {
      input: { filter, active: model.filter === filter },
      h,
    })
    return h.button(
      item.button.attrs([h.Type('button'), h.OnClick(Message.FilterSelected({ filter }))]),
      [filter],
    )
  }

  const row = (todo: Todo) => {
    const editing = model.editingId === todo.id
    const input: ItemInput = { todo, editing, editDraft: model.editDraft }
    const item = SlotView.buildersFor(ItemSlots, itemMixins, { input, h })
    return h.li(item.root.attrs([h.Key(todo.id)]), [
      UiCheckbox.view(
        {
          id: `todo-${todo.id}`,
          isChecked: todo.completed,
          onToggle: () => Message.ToggledTodo({ id: todo.id }),
          toView: attributes => {
            const resolved = CheckboxAdapter.resolve(attributes, [ToggleStyle.mixin], { input, h })
            return h.button(
              [...resolved.checkbox, h.AriaLabel(todo.completed ? 'Mark active' : 'Mark done')],
              [todo.completed ? '✓' : ''],
            )
          },
        },
        h,
      ),
      editing
        ? h.form(
            [h.OnSubmit(Message.EditingCommitted({}))],
            [
              h.input(
                item.editor.attrs([
                  h.Type('text'),
                  h.Value(model.editDraft),
                  h.OnInput(value => Message.EditDraftChanged({ value })),
                  h.OnBlur(Message.EditingCommitted({})),
                ]),
              ),
            ],
          )
        : h.span(
            item.title.attrs([
              h.Title('Double-click to rename'),
              h.OnDoubleClick(Message.EditingStarted({ id: todo.id })),
            ]),
            [todo.title],
          ),
      h.button(
        item.priority.attrs([
          h.Type('button'),
          h.AriaLabel(`Priority ${todo.priority}, click to change`),
          h.OnClick(Message.PrioritySet({ id: todo.id, priority: bumpPriority(todo.priority) })),
        ]),
        [todo.priority],
      ),
      h.button(
        item.remove.attrs([
          h.Type('button'),
          h.AriaLabel(`Delete "${todo.title}"`),
          h.OnClick(Message.DeletedTodo({ id: todo.id })),
        ]),
        ['×'],
      ),
    ])
  }

  const rows = visibleTodos(model)
  return h.section(slots.root.attrs(), [
    h.nav(slots.filters.attrs([h.AriaLabel('Filter')]), filters.map(filterButton)),
    rows.length === 0
      ? h.p(slots.empty.attrs(), ['Nothing here.'])
      : h.ul(slots.list.attrs(), rows.map(row)),
  ])
}).pipe(Style.attach(BoardStyle))

// --- footer --------------------------------------------------------------------------

export const FooterView = SurfaceView.define(Footer, FooterSlots, (model, slots, h) => {
  const tally = counts(model)
  return h.footer(slots.root.attrs(), [
    h.p(slots.status.attrs(), [
      model.lastError ?? `${tally.total} ${tally.total === 1 ? 'todo' : 'todos'}`,
    ]),
    UiButton.view(
      {
        isDisabled: tally.completed === 0,
        onClick: Message.ClearedCompleted({}),
        toView: attributes =>
          h.button(
            ButtonAdapter.resolve(attributes, [ClearButtonStyle.mixin], { input: model, h }).button,
            ['Clear completed'],
          ),
      },
      h,
    ),
  ])
}).pipe(Style.attach(FooterStyle))

// --- the page: the Root boundary ------------------------------------------------------

/**
 * `Surface.rootView` is where the whole Model meets a Surface: it projects the
 * Root and hands the projected Model to the renderer. The renderer's builder is
 * narrowed to the Surface's Messages, so a Board renderer cannot dispatch
 * `RequestedTodo` even though the page's builder could.
 */
const HeaderRoot = Surface.rootView(Header, undefined, SurfaceView.toRenderer(HeaderView))
const ComposerRoot = Surface.rootView(Composer, undefined, SurfaceView.toRenderer(ComposerView))
const BoardRoot = Surface.rootView(Board, undefined, SurfaceView.toRenderer(BoardView))
const FooterRoot = Surface.rootView(Footer, undefined, SurfaceView.toRenderer(FooterView))

const PageView = SlotView.define(PageSlots, (model: Model, slots, h: HtmlBuilder<Message>) =>
  h.main(slots.root.attrs(), [
    HeaderRoot(model, h),
    ComposerRoot(model, h),
    BoardRoot(model, h),
    FooterRoot(model, h),
  ]),
).pipe(Style.attach(PageStyle))

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.listTitle,
  body: PageView(model, h),
})
