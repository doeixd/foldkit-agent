# foldkit-mixins

Typed slot contracts and inside-out Style/Behavior attachments for Foldkit.

A view publishes the structural points it is willing to customize. Style and
Behavior attach to those points — from outside, without forking the view.
Application state stays in the Foldkit Model; this package never owns a second
runtime.

```text
                Slots contract
                      │
          ┌───────────┴───────────┐
        Style                  Behavior
     appearance              interaction
          │                       │
          └───────────┬──────────┘
                      ▼
                    Mixin
              slot contributions
                      │
                      ▼
          ordinary Foldkit attributes
```

## Why

- **Customize without forking.** A component publishes a slot contract; a style
  or behavior attaches to it. The component's markup and state are untouched.
- **Appearance and interaction are separate axes.** A style does not know about a
  behavior; both compile to the same contribution and merge through one resolver.
- **One cause model.** A behavior owns no state: state is a Foldkit
  Model/Submodel, a transition is `update`, a network call is Message → Command,
  and an element-owned effect is a `Mount`. The view's Message universe governs
  every attribute a mixin can build.

## Quick start

```ts
import {
  Attr,
  Behavior,
  Capability,
  Event,
  Slot,
  Slots,
  SlotView,
  Style,
} from 'foldkit-mixins'

// 1. The view publishes the attachment points it will honor.
const FieldSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  input: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Input, Event.Focus],
    attributes: [Attr.AriaInvalid],
  }),
})

// 2. Style attaches to slots.
const FieldStyle = Style.forSlots(FieldSlots)({
  root: Style.compose(Style.class('field'), Style.inline({ display: 'grid' })),
  input: Style.class('field-input'),
})

// 3. Behavior attaches to slots, built from the view's input and h.
const Validation = Behavior.forSlots(FieldSlots)<{ readonly invalid: boolean }, Message>({
  input: Behavior.slot({
    requires: { capability: Capability.TextInput, attributes: [Attr.AriaInvalid] },
    attributes: ({ input, h }) => [h.AriaInvalid(input.invalid)],
  }),
})

// 4. The view publishes slots through its render function.
const Field = SlotView.define(
  FieldSlots,
  (input: { readonly value: string; readonly invalid: boolean }, slots, h) =>
    h.label(slots.root.attrs(), [
      h.input(slots.input.attrs([h.Value(input.value)])),
    ]),
).pipe(Style.attach(FieldStyle), Behavior.attach(Validation))
```

`slots.input.attrs(base)` returns the base attributes plus every attached
contribution, resolved deterministically. Base attributes, event Messages and any
`ChildAttribute` are preserved; the resolver is the only place merge policy lives.

## Slots

A slot is named metadata, not a DOM node:

```ts
Slot.make({
  capability: Capability.TextInput, // what it structurally is
  events: [Event.Input],            // what it emits
  attributes: [Attr.AriaInvalid],   // what it exposes
  hidden: false,                    // internal attachment points are hidden
  protected: { events: [Event.Click], attributes: [Attr.Role], style: ['position'] },
})
```

- **Capability** is a hierarchy (`Base → Interactive → { Container, Focusable →
  TextInput, Draggable }`). A behavior that requires `Interactive` attaches to a
  `TextInput`. Extend it with `Capability.make(name, { extends })`.
- **Event** and **Attr** are branded tokens; `Event.make`/`Attr.make` add custom
  ones. They are metadata: they do not install handlers.
- **Requirements** are platform tokens (`Requirement.Keyboard`, …).
- `hidden` reserves an internal point that public mixins cannot target.
- `protected` keeps structural pieces (an event, an attribute, a style property)
  from being replaced by an attachment.

Names come from the `Slots.define` keys, never repeated inside the value.

## Style

Pure data; it never touches the DOM.

| Primitive | Meaning |
| --- | --- |
| `Style.class(...)` | class tokens |
| `Style.inline({...})` | inline declarations |
| `Style.compose(...)` | concatenate classes, later declarations win per property |
| `Style.when(condition, piece)` | a boolean known at authoring time |
| `Style.whenInput(predicate, piece)` | a condition read from the view input at render time |
| `Style.recipe({ base, variants, defaults, compound })` | a typed variant selector |
| `Style.pseudo`/`media`/`supports`/`container`/`nest` | rule-based appearance |
| `Style.keyframes`/`global` | class-independent CSS |
| `Theme.define`/`variable`/`variables` | typed tokens and CSS custom properties |

Rule-based styles compile to **one deterministic class** (an FNV-1a hash of the
canonical rule text) plus CSS as data:

```ts
const CardStyle = Style.forSlots(CardSlots)({
  root: Style.compose(
    Style.class('card'),
    Style.pseudo(':hover', { boxShadow: '0 1px 2px' }),
    Style.media('(min-width: 40rem)', { gridTemplateColumns: '1fr 1fr' }),
  ),
})

CardStyle.css        // `.style-…:hover{box-shadow:0 1px 2px}@media (min-width: 40rem){…}`
Style.stylesheet(CardStyle, OtherStyle) // deduplicated, deterministic
```

Equal rules share a class; nothing mutates the DOM, so the server and the client
derive the same class and rules. Rules inside `Style.whenInput` are rejected
(`style:conditional-rules-unsupported`) because the class is static while the
condition is not. See [DESIGN.md](./DESIGN.md) for the compiler's scope.

## Behavior

A named set of interaction contributions. Attributes are built while resolving,
from the view's `input` and `h`, so the view's Message universe is the only one a
behavior can emit into.

```ts
const Archive = Behavior.forSlots(CardSlots)<CardInput, CardMessage>({
  archive: Behavior.slot({
    requires: { events: [Event.Click] },
    attributes: ({ input, h }) => (input.archived ? [h.AriaDisabled(true)] : []),
    mount: input => MeasureCard(input.id), // a Foldkit `Mount.define*` action
  }),
})
```

A behavior owns no state. A stateful widget is a Foldkit Submodel; a continuous
element listener is a `Mount`; a network call is Message → `update` → Command.
Multiple mount contributions compose into **one** `OnMount` per element.

## SlotView

`SlotView.define(slots, render)` is a pure view that publishes slots. Attach with
`SlotView.attach`, `Style.attach` or `Behavior.attach`; the view is immutable.
For a component whose render payload has **per-item** groups (tabs, options,
calendar cells), call `SlotView.buildersFor(slots, mixins, { input, h })` and map
the items yourself.

## A11y

```ts
const DialogPattern = A11y.pattern({
  trigger: { capability: Capability.Interactive, events: [Event.Click] },
  content: { capability: Capability.Container },
})

A11y.validate(DialogPattern, DialogSlots) // ReadonlyArray<A11yDiagnostic>
```

`validate` is pure and DOM-independent: it checks the declared contract, never a
rendered tree, and reports missing or hidden slots, capability mismatches and
unpublished events or attributes in authored order. It does not certify WCAG.

## Introspection and diagnostics

- `Slots.describe(contract)` and `Slot.describe(slot)` return serializable
  metadata.
- Conflicts throw a `Diagnostics.DiagnosticError` with a stable code
  (`mixins:event-conflict`, `mixins:protected-attribute`, …) and a `details`
  record, so tests, DevTools and editor tooling share one shape.
- `Mixin.compose` merges mixins; `Mixin.make`/`Mixin.dynamic`/`Mixin.empty` build
  them.

## Adapters

- [`foldkit-mixins-ui`](../mixins-ui) publishes `@foldkit/ui` attribute bundles as
  slots (Button, Input, Checkbox, Disclosure, Dialog, Popover, Tooltip, Slider,
  Tabs, RadioGroup, Calendar, …).
- [`foldkit-mixins-surface`](../mixins-surface) binds a `foldkit-surface`
  projection and Message subset to a `SlotView`.

## Boundaries

This package does not introduce local reactive state, hooks, a query cache, a
second update loop, mutable element handles as the default path, or an event bus.
It does not replace Foldkit Commands, Subscriptions, Mounts, ManagedResources or
`@foldkit/ui`.

Private while the API is settling (`0.0.0`). [DESIGN.md](./DESIGN.md) records the
substrate probes and the decisions they forced;
[`examples/mixins`](../../examples/mixins) is a runnable trace.
