/**
 * Appearance and interaction, attached from outside the views.
 *
 * `foldkit-mixins` splits a view into three things:
 *
 * - **Slots**: the points a view is willing to let others customize, named and
 *   typed by capability and by the events they expose.
 * - **Style**: appearance as data. Classes and inline declarations, conditions
 *   read from the view's input at render time, recipes for variants, and
 *   rule-based pieces (`pseudo`, `media`, `nest`) that compile to one
 *   deterministic class plus CSS.
 * - **Behavior**: interaction attached to a slot, built from the view's input
 *   and its builder, so it can only emit Messages the view may emit.
 *
 * None of this owns state. The views in `view.ts` publish the slots; this file
 * never sees markup.
 */
import { Option } from 'effect'
import {
  Attr,
  Behavior,
  Capability,
  Event,
  Slot,
  Slots,
  Style,
  Theme,
  type StyleValue,
} from 'foldkit-mixins'
import { ButtonSlots, CheckboxSlots } from 'foldkit-mixins-ui'
import { Message, type Filter, type Priority, type Todo } from './app.js'
import type { BoardMessage } from './surface.js'

// --- theme: typed tokens that compile to CSS custom properties ----------------

export const theme = Theme.define({
  color: {
    bg: '#f6f7f9',
    card: '#ffffff',
    ink: '#1c2430',
    muted: '#6b7686',
    line: '#e3e7ee',
    accent: '#4f46e5',
    accentInk: '#ffffff',
    danger: '#e5484d',
    done: '#9aa4b2',
    high: '#d97706',
    low: '#0891b2',
  },
  radius: { card: '16px', control: '10px', pill: '999px' },
})

/** `var(--fk-color-accent)`: a token reference, checked against the theme. */
const v = <G extends keyof typeof theme & string>(
  group: G,
  name: keyof (typeof theme)[G] & string,
) => Theme.variable(theme, group, name)

const control: StyleValue = Style.inline({
  font: 'inherit',
  borderRadius: v('radius', 'control'),
})

// --- the page ------------------------------------------------------------------

export const PageSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
})

export const PageStyle = Style.forSlots(PageSlots)(
  {
    root: Style.compose(
      // The theme's tokens become custom properties on the root, so everything
      // below reads them and a stylesheet can override them (dark mode lives in
      // styles.css, as an override of these variables).
      Theme.variables(theme),
      Style.class('app'),
      Style.inline({
        width: 'min(40rem, 100%)',
        background: v('color', 'card'),
        color: v('color', 'ink'),
        border: `1px solid ${v('color', 'line')}`,
        borderRadius: v('radius', 'card'),
        padding: '1.75rem',
        boxShadow: '0 12px 40px rgb(0 0 0 / 8%)',
      }),
      Style.media('(max-width: 30rem)', { padding: '1rem', borderRadius: '0' }),
    ),
  },
  { name: 'PageStyle' },
)

// --- header --------------------------------------------------------------------

export const HeaderSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  title: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Change],
    attributes: [Attr.AriaLabel],
  }),
  tally: Slot.make({ capability: Capability.Container }),
})

export const HeaderStyle = Style.forSlots(HeaderSlots)(
  {
    root: Style.inline({
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '1rem',
    }),
    title: Style.compose(
      control,
      Style.inline({
        border: '0',
        background: 'transparent',
        color: 'inherit',
        fontSize: '1.6rem',
        fontWeight: '700',
        letterSpacing: '-0.02em',
        padding: '0.1rem 0.25rem',
        margin: '0 -0.25rem',
        minWidth: '0',
      }),
      Style.pseudo(':focus-visible', {
        outline: `2px solid ${v('color', 'accent')}`,
        outlineOffset: '2px',
      }),
    ),
    tally: Style.inline({ margin: '0', color: v('color', 'muted'), fontSize: '0.85rem' }),
  },
  { name: 'HeaderStyle' },
)

// --- composer --------------------------------------------------------------------

export const ComposerSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container, events: [Event.Submit] }),
  input: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Input],
    attributes: [Attr.AriaLabel],
  }),
})

export const ComposerStyle = Style.forSlots(ComposerSlots)(
  {
    root: Style.inline({ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }),
    input: Style.compose(
      control,
      Style.inline({
        flex: '1',
        padding: '0.7rem 0.85rem',
        border: `1px solid ${v('color', 'line')}`,
        background: 'transparent',
        color: 'inherit',
      }),
      Style.pseudo(':focus', {
        outline: `2px solid ${v('color', 'accent')}`,
        outlineOffset: '1px',
      }),
    ),
  },
  { name: 'ComposerStyle' },
)

/**
 * The Add button is a `@foldkit/ui` Button. The component builds the
 * accessible attribute bundle and owns the click; this style attaches to the
 * contract `foldkit-mixins-ui` publishes for it, so the component is never
 * copied to restyle it.
 */
export const AddButtonStyle = Style.forSlots(ButtonSlots)(
  {
    button: Style.compose(
      control,
      Style.inline({
        padding: '0.7rem 1.1rem',
        border: '0',
        background: v('color', 'accent'),
        color: v('color', 'accentInk'),
        fontWeight: '600',
        cursor: 'pointer',
      }),
      Style.pseudo(':disabled', { opacity: '0.45', cursor: 'default' }),
    ),
  },
  { name: 'AddButtonStyle' },
)

// --- filters: one slot, resolved once per filter with the filter as input --------

export interface FilterInput {
  readonly filter: Filter
  readonly active: boolean
}

export const FilterSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.AriaSelected],
  }),
})

export const FilterStyle = Style.forSlots(FilterSlots)(
  {
    button: Style.compose(
      Style.class('filter'),
      Style.inline({
        padding: '0.3rem 0.75rem',
        border: '1px solid transparent',
        borderRadius: v('radius', 'pill'),
        background: 'transparent',
        color: v('color', 'muted'),
        font: 'inherit',
        textTransform: 'capitalize',
        cursor: 'pointer',
      }),
      // A condition read from the input at render time: the same slot, styled
      // per filter without a class per state in the view.
      Style.whenInput<FilterInput>(
        input => input.active,
        Style.inline({
          borderColor: v('color', 'line'),
          background: `color-mix(in srgb, ${v('color', 'accent')} 12%, transparent)`,
          color: v('color', 'accent'),
        }),
      ),
      Style.pseudo(':hover', { color: v('color', 'ink') }),
    ),
  },
  { name: 'FilterStyle' },
)

/** Interaction for the same slot: the selected filter announces itself. */
export const FilterBehavior = Behavior.forSlots(FilterSlots)<FilterInput, BoardMessage>(
  {
    button: Behavior.slot({
      requires: { events: [Event.Click], attributes: [Attr.AriaSelected] },
      attributes: ({ input, h }) => [h.AriaSelected(input.active)],
    }),
  },
  { name: 'FilterBehavior' },
)

// --- one todo row --------------------------------------------------------------

export interface ItemInput {
  readonly todo: Todo
  readonly editing: boolean
  readonly editDraft: string
}

export const ItemSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  title: Slot.make({ capability: Capability.Interactive, events: [Event.Click] }),
  priority: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.AriaLabel],
  }),
  remove: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.AriaLabel],
  }),
  editor: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Input, Event.KeyDown, Event.Blur],
    attributes: [Attr.AriaLabel],
  }),
})

/** A recipe: the priority badge's appearance as a typed variant selector. */
const badge = Style.recipe({
  base: Style.compose(
    Style.class('badge'),
    Style.inline({
      border: '0',
      borderRadius: v('radius', 'pill'),
      padding: '0.1rem 0.55rem',
      font: 'inherit',
      fontSize: '0.75rem',
      cursor: 'pointer',
      background: `color-mix(in srgb, currentColor 12%, transparent)`,
    }),
  ),
  variants: {
    priority: {
      high: Style.inline({ color: v('color', 'high') }),
      normal: Style.inline({ color: v('color', 'muted') }),
      low: Style.inline({ color: v('color', 'low') }),
    },
  },
  defaults: { priority: 'normal' },
})

const priorities: ReadonlyArray<Priority> = ['high', 'normal', 'low']

export const ItemStyle = Style.forSlots(ItemSlots)(
  {
    root: Style.compose(
      Style.class('item'),
      Style.inline({
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.6rem 0',
        borderTop: `1px solid ${v('color', 'line')}`,
      }),
      // `nest` styles a descendant from the row's own class, so hovering the
      // row reveals its delete button without the view knowing.
      Style.nest(' .item-remove', { opacity: '0' }),
      Style.nest(':hover .item-remove, :focus-within .item-remove', { opacity: '1' }),
    ),
    title: Style.compose(
      Style.inline({ flex: '1', cursor: 'text' }),
      Style.whenInput<ItemInput>(
        input => input.todo.completed,
        Style.inline({ color: v('color', 'done'), textDecoration: 'line-through' }),
      ),
    ),
    // The recipe picks the variant from the input, one piece per priority.
    priority: Style.compose(
      ...priorities.map(priority =>
        Style.whenInput<ItemInput>(input => input.todo.priority === priority, badge({ priority })),
      ),
    ),
    remove: Style.compose(
      Style.class('item-remove'),
      Style.inline({
        border: '0',
        background: 'transparent',
        color: v('color', 'muted'),
        fontSize: '1.2rem',
        lineHeight: '1',
        cursor: 'pointer',
      }),
      Style.pseudo(':hover', { color: v('color', 'danger') }),
    ),
    editor: Style.compose(
      control,
      Style.inline({
        flex: '1',
        padding: '0.3rem 0.5rem',
        border: `1px solid ${v('color', 'accent')}`,
        background: 'transparent',
        color: 'inherit',
      }),
    ),
  },
  { name: 'ItemStyle' },
)

/**
 * The editor's keyboard interaction, attached as a Behavior rather than written
 * into the view: Escape cancels, focus lands on the field as it appears.
 */
export const EditorBehavior = Behavior.forSlots(ItemSlots)<ItemInput, BoardMessage>(
  {
    editor: Behavior.slot({
      requires: { events: [Event.KeyDown] },
      attributes: ({ input, h }) => [
        h.Autofocus(input.editing),
        h.AriaLabel(`Rename "${input.todo.title}"`),
        h.OnKeyDownPreventDefault(key =>
          key === 'Escape' ? Option.some(Message.EditingStopped({})) : Option.none(),
        ),
      ],
    }),
  },
  { name: 'EditorBehavior' },
)

/** The row's checkbox is a `@foldkit/ui` Checkbox; its contract has the slots. */
export const ToggleStyle = Style.forSlots(CheckboxSlots)(
  {
    checkbox: Style.compose(
      Style.inline({
        width: '1.5rem',
        height: '1.5rem',
        display: 'grid',
        placeItems: 'center',
        border: `1px solid ${v('color', 'line')}`,
        borderRadius: '50%',
        background: 'transparent',
        color: v('color', 'accent'),
        cursor: 'pointer',
        padding: '0',
      }),
      Style.whenInput<ItemInput>(
        input => input.todo.completed,
        Style.inline({ borderColor: v('color', 'accent') }),
      ),
      Style.pseudo(':focus-visible', {
        outline: `2px solid ${v('color', 'accent')}`,
        outlineOffset: '2px',
      }),
    ),
  },
  { name: 'ToggleStyle' },
)

// --- footer ----------------------------------------------------------------------

export const FooterSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  status: Slot.make({ capability: Capability.Container }),
})

export const FooterStyle = Style.forSlots(FooterSlots)(
  {
    root: Style.inline({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '1rem',
      marginTop: '1rem',
      paddingTop: '1rem',
      borderTop: `1px solid ${v('color', 'line')}`,
      color: v('color', 'muted'),
      fontSize: '0.85rem',
    }),
    status: Style.inline({ margin: '0' }),
  },
  { name: 'FooterStyle' },
)

export const ClearButtonStyle = Style.forSlots(ButtonSlots)(
  {
    button: Style.compose(
      Style.inline({
        border: '0',
        background: 'transparent',
        color: v('color', 'muted'),
        font: 'inherit',
        cursor: 'pointer',
      }),
      Style.pseudo(':disabled', { opacity: '0.5', cursor: 'default' }),
      Style.pseudo(':not(:disabled):hover', { color: v('color', 'danger') }),
    ),
  },
  { name: 'ClearButtonStyle' },
)

// --- the stylesheet ----------------------------------------------------------------

/**
 * Every rule-based piece above (`pseudo`, `media`, `nest`) compiles to a class
 * named by a hash of its rule, so the same Style yields the same class on the
 * server and in the browser. This is the CSS those classes need; `client.ts`
 * injects it once.
 */
export const stylesheet = Style.stylesheet(
  PageStyle,
  HeaderStyle,
  ComposerStyle,
  AddButtonStyle,
  FilterStyle,
  ItemStyle,
  ToggleStyle,
  FooterStyle,
  ClearButtonStyle,
)
