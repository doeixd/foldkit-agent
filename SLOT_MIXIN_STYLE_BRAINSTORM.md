
Yes. After reading through `effect-atom-jsx`, current Foldkit internals/docs, `@foldkit/ui`, and the existing `foldkit-plus` packages, I think there is a very natural package here—but it should be a **Foldkit-native reinterpretation** of AF-UI rather than a direct port.

The important thing I found is that `effect-atom-jsx` does not really have one monolithic “Mixin” primitive. Its useful abstraction is an **inside-out attachment algebra**: a component publishes a typed slot contract; `Style` and `Behavior` independently consume that contract; capabilities/events/attributes validate whether an attachment makes sense; attachments compose from outside without forking the component.  The behavior runtime is an Effect over typed element handles and accumulates Effect requirements/errors, while Style is mostly composable data.

I think **`foldkit-mixins`** is the right initial package name.

## What actually ports cleanly

The mapping looks like this:

| `effect-atom-jsx`          | Foldkit-native version                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `View.Slots`               | `Slots` public structural contract                                     |
| `Element.Capability`       | abstract slot capabilities                                             |
| `Style`                    | pure slot → Foldkit attribute/style data                               |
| `Behavior`                 | slot-local declarative attrs/Messages + optional element lifecycle     |
| `Behavior.compose`         | compose slot contributions                                             |
| Component bindings         | **do not port**; use Foldkit Model/Submodel                            |
| Element Handle             | mostly **do not port**; normal behaviors compile to Foldkit attributes |
| imperative handle behavior | Foldkit `Mount`                                                        |
| scoped cleanup             | Foldkit `Mount` / Effect Scope                                         |
| behavior-owned state       | Foldkit Model/Submodel                                                 |
| theme tokens               | pure theme/style descriptors                                           |
| A11y contracts             | slot-contract validation                                               |
| capability attachment      | compile-time slot compatibility                                        |
| styled composables         | mixin-enhanced Foldkit render helpers                                  |

The reason this fits so well is that `@foldkit/ui` already has half the required seam. Its components don't own markup; they produce typed attribute groups and hand them to consumer-owned `toView` callbacks. `Button.view`, for example, produces a typed `button: Attribute<Message>[]` bundle containing accessibility/state/event attributes.

So you don't need to replace Foldkit UI. You need to formalize the **public structural contract around those attribute bundles**.

## The fundamental abstraction should be slots

I'd start with:

```ts
import {
  Behavior,
  Capability,
  Event,
  Slot,
  Slots,
  Style,
} from "foldkit-mixins"
```

And:

```ts
const FieldSlots = Slots.make({
  root: Slot.make({
    capability: Capability.Container,
  }),

  label: Slot.make({
    capability: Capability.Container,
  }),

  input: Slot.make({
    capability: Capability.TextInput,
    events: [
      Event.Input,
      Event.Focus,
      Event.Blur,
    ],
  }),
})
```

This is a **public customization contract**.

It does not represent DOM nodes.

It means:

```text
Field
│
├ root
│   capability: Container
│
├ label
│   capability: Container
│
└ input
    capability: TextInput
    events:
      Input
      Focus
      Blur
```

That preserves one of the best ideas in AF-UI: if the component implementation changes but its published slot contract doesn't, downstream styles and behaviors continue working.

And just like your existing AF-UI design says, components that don't need public customization shouldn't pay for this abstraction at all.

---

# The Foldkit version should operate on attributes

This is the biggest architectural difference.

AF-UI's runtime has renderer-neutral `Element.Handle` objects that Behaviors mutate/subscribe to. Those handles expose things like `listen`, `setAttr`, `setStyle`, focus, and collections.

Foldkit doesn't want that as its normal path.

Its normal path is:

```ts
h.button(
  [
    h.Class(...),
    h.AriaLabel(...),
    h.OnClick(...),
  ],
  ...
)
```

and its `Attribute<Message>` is already a first-class tagged value.

So the primary output of a slot should simply be:

```ts
ReadonlyArray<
  Attribute<Message> | ChildAttribute
>
```

That is much more Foldkit-native.

---

# A mixin-aware view

I imagine something approximately like:

```ts
const Field = Mixin.view(
  FieldSlots,

  (
    props: {
      readonly label: string
      readonly value: string
      readonly onInput: Message
    },
    slots,
    h,
  ) =>
    h.label(
      slots.root(),
      [
        h.span(
          slots.label(),
          [props.label],
        ),

        h.input(
          slots.input([
            h.Value(props.value),
            h.OnInput(props.onInput),
          ]),
        ),
      ],
    ),
)
```

Notice:

```ts
slots.input(baseAttributes)
```

returns the base attributes plus whatever external attachments have been composed onto `input`.

The underlying renderer remains completely ordinary Foldkit.

No special VDOM.

No component-local runtime.

No hidden signal system.

---

# Style becomes extremely natural

```ts
const FieldStyle = Style.forSlots(
  FieldSlots,
)({
  root: Style.compose(
    Style.class("field"),
    Style.inline({
      display: "grid",
      gap: "0.5rem",
    }),
  ),

  label: Style.class("field-label"),

  input: Style.compose(
    Style.class("field-input"),
    Style.inline({
      padding: "0.5rem",
    }),
  ),
})
```

Attach it:

```ts
const StyledField = Field.pipe(
  Style.attach(FieldStyle),
)
```

Internally:

```text
Style.class(...)
    ↓
h.Class(...)

Style.inline(...)
    ↓
h.Style(...)
```

Foldkit already has native `Class` and `Style` attributes, and `h.Style({...})` is extensively used by core UI itself.

So **we should compile onto Foldkit's styling primitives, not install a competing renderer**.

---

# Style should remain data

This is another part worth retaining from AF-UI.

Your current `StyleValue` is an algebra of composable data—slot pieces, conditional pieces, states, responsive rules, animations, nesting, media/support queries, CSS variables, layers, etc.

I'd preserve the idea:

```ts
Style.compose(
  Style.inline(...),
  Style.when(...),
  Style.variant(...),
)
```

but initially implement the Foldkit subset that maps cleanly to native attributes:

```text
Class
Inline style
Data attributes
CSS variables
conditional pieces
recipes / variants
theme token resolution
```

Pseudo selectors, `@media`, keyframes, container queries, global rules, etc. should eventually compile to a deterministic stylesheet/class representation rather than pretending they are inline styles.

That's large enough that **Style may eventually deserve `foldkit-style`**, but I would not split it out initially.

---

# Theme should change somewhat

AF-UI currently provides Theme as an Effect service with reactive Atom-owned light/dark mode.

I would not port that runtime literally.

A Foldkit view is pure.

Dynamic theme state belongs in:

```text
Model
```

or is represented using CSS variables/classes.

So something like:

```ts
const Brand = Theme.make({
  color: {
    accent: "#625cff",
    text: "#161616",
  },

  spacing: {
    sm: "0.5rem",
    md: "1rem",
  },
})
```

Then:

```ts
Style.inline({
  color: Brand.color.text,
  padding: Brand.spacing.sm,
})
```

Or:

```ts
Theme.class(Brand, model.theme)
```

if we're generating variables.

No hidden theme state beside Model.

---

# Behavior is where the port needs the most care

I would **not** port this AF-UI idea literally:

```ts
Behavior<Elements, Bindings, Req, E>
```

where the behavior creates local state and returns component bindings.

For example your current `disclosure`, `selection`, `keyboardNav`, `focusTrap`, etc. create Atom state internally.

That's fine for `effect-atom-jsx`.

It is wrong for Foldkit.

In Foldkit:

```text
state
  → Model / Submodel

event
  → Message

transition
  → update

external work caused by Message
  → Command

ongoing external source
  → Subscription

element-owned effect
  → Mount
```

That distinction is one of Foldkit's core design choices.

So Foldkit Behavior should mean:

> **A reusable declaration of things that attach to structural slots.**

Not:

> a hidden mini state manager.

---

# Most Behaviors should just compile to attributes

For example:

```ts
const Pressable = Behavior.forSlots(
  ButtonSlots,
)((props, h) => ({
  button: [
    h.Role("button"),
    h.OnClick(props.onPress),
  ],
}))
```

or perhaps a more descriptor-oriented API:

```ts
const Pressable = Behavior.make({
  button: Behavior.attributes(
    (props, h) => [
      h.Role("button"),
      h.OnClick(props.onPress),
    ],
  ),
})
```

Then:

```ts
const InteractiveButton = ButtonView.pipe(
  Behavior.attach(Pressable),
)
```

That behavior is entirely declarative.

No DOM listeners outside Foldkit.

No cleanup.

No effect.

No hidden state.

---

# Stateful behavior becomes a Foldkit Submodel

Say you want disclosure behavior.

AF-UI's version internally creates:

```text
isOpen
open
close
toggle
```

as Atom bindings.

The Foldkit version should instead be:

```text
Disclosure.Model
Disclosure.Message
Disclosure.update
Disclosure.view
```

which Foldkit already has in `@foldkit/ui`.

And the slot/mixin system merely decides:

```text
where its published attributes attach
```

That means the new package **complements `@foldkit/ui` instead of rebuilding it**.

That's a critical architectural boundary.

---

# Existing Foldkit UI slots become immediately mixin-able

Consider current Button:

```ts
Button.view(
  {
    onClick: Saved(),

    toView: attributes =>
      h.button(
        [
          ...attributes.button,
          h.Class("my-style"),
        ],
        ["Save"],
      ),
  },
  h,
)
```

Today the implicit public slot is:

```text
button
```

We can formalize that:

```ts
const ButtonSlots = Slots.make({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
  }),
})
```

Then:

```ts
const SaveButtonStyle =
  Style.forSlots(ButtonSlots)({
    button: Style.compose(
      Style.class("save-button"),
      Style.inline({
        borderRadius: "0.5rem",
      }),
    ),
  })
```

and:

```ts
Button.view(
  {
    onClick: Saved(),

    toView: attributes =>
      h.button(
        Mixins.resolve(
          ButtonSlots.button,
          attributes.button,
          SaveButtonStyle,
          h,
        ),
        ["Save"],
      ),
  },
  h,
)
```

Eventually sugar should make that less verbose.

---

# `ChildAttribute` makes this much safer than I initially expected

This is an important Foldkit detail.

Stateful `@foldkit/ui` Submodels can publish attribute bundles that contain event handlers. Foldkit's `childAttributes(...)` captures the child's dispatcher/boundary so those handlers still dispatch through the correct child when the parent later spreads them into its own markup.

Therefore the mixin resolver must treat existing attributes as opaque values:

```text
base ChildAttributes
+
mixin Attributes
```

Never unpack/reconstruct them.

Then Submodel ownership survives composition automatically.

That's a really strong existing foundation.

---

# Imperative Behaviors compile to Mount

Sometimes a behavior genuinely needs a live element:

```text
ResizeObserver
IntersectionObserver
third-party widget
element measurement
DOM-owned listener that must run synchronously
```

Then:

```ts
const AutoResize = Behavior.mount(
  FieldSlots.input,
  ResizeInput,
)
```

where:

```ts
ResizeInput
```

is built from Foldkit's Mount machinery.

But there is a serious constraint:

> Foldkit supports one Mount per element.

Two `h.OnMount(...)` attributes on one node do **not** compose; the second replaces the first. Foldkit explicitly warns that callers must combine them into a single Mount.

So `foldkit-mixins` can actually add major value here.

---

# `Behavior.compose` should compose Mounts correctly

Suppose:

```ts
const behavior = Behavior.compose(
  ResizeBehavior,
  IntersectionBehavior,
  TooltipAnchorBehavior,
)
```

all attach to `root`.

The user should get:

```text
ONE h.OnMount(...)
```

not three.

Internally:

```text
Resize stream ───────────┐
Intersection stream ─────┼──▶ combined Mount stream
Tooltip mount stream ────┘
```

Foldkit's public `MountAction` is fundamentally:

```ts
{
  name,
  args?,
  f(element, viewStateChanges):
    Stream<Message>
}
```

That makes a mixin-level **Mount composer** quite feasible.

It can combine all behavior streams into one `MountAction` and emit one `OnMount`.

That alone would be a very useful utility.

And because it uses Foldkit Mount underneath, it retains:

```text
Effect Scope cleanup
time-travel awareness
Scene visibility
Message dispatch
unmount interruption
```

rather than inventing another lifecycle.

---

# But Behavior needs to respect Foldkit's cause model

I would explicitly prevent `Behavior` from becoming a grab bag.

If something wants to:

```text
call an API after ClickedSave
```

that's not a behavior Mount.

It's:

```text
Message
→ update
→ Command
```

If it wants to:

```text
listen to WebSocket while Model condition is true
```

that's:

```text
Subscription
```

If it wants to:

```text
hold a long-lived editor handle controlled by Model
```

that's:

```text
ManagedResource
```

Only element-owned lifecycle belongs in a mount contribution.

That distinction will keep this package from becoming React hooks under another name.

---

# Mixin should be the normalized internal representation

This is where I think the name becomes useful.

Conceptually:

```ts
interface Mixin<Slots, Props, Message> {
  readonly slots: {
    readonly [K in keyof Slots]?:
      SlotContribution<Props, Message>
  }
}
```

And:

```ts
interface SlotContribution<Props, Message> {
  readonly attributes?: ...
  readonly styles?: ...
  readonly mounts?: ...
}
```

Then:

```text
Style
Behavior
A11y helpers
animation helpers
future drag helpers
```

all compile into the same attachment representation.

So:

```ts
const FancyField = Field.pipe(
  Style.attach(FieldStyle),
  Behavior.attach(FocusBehavior),
  Behavior.attach(ResizeBehavior),
)
```

is internally approximately:

```text
Mixin.compose(
  Style.toMixin(FieldStyle),
  Behavior.toMixin(FocusBehavior),
  Behavior.toMixin(ResizeBehavior),
)
```

Users don't necessarily need to see that conversion.

But one common algebra underneath everything is exactly the right design.

---

# Capabilities should survive the port

This is also worth keeping from AF-UI.

Currently your hierarchy is roughly:

```text
Base
└ Interactive
  ├ Container
  ├ Focusable
  │ └ TextInput
  └ Draggable
```

and custom capabilities can extend existing ones.

So a behavior that needs:

```ts
Capability.Interactive
```

can attach to:

```text
TextInput
Focusable
button-like
custom capability extending Interactive
```

without tying itself to `<button>`.

That abstraction still makes sense in Foldkit even though we no longer expose runtime Handle objects.

Capability becomes a property of the **public structural slot contract**, not a runtime object interface.

---

# Event requirements become especially valuable

For example:

```ts
const FieldSlots = Slots.make({
  input: Slot.make({
    capability: Capability.TextInput,

    events: [
      Event.Input,
      Event.Focus,
    ],
  }),
})
```

Then:

```ts
const NeedsBlur = Behavior.make({
  input: Behavior.event(
    Event.Blur,
    ...
  ),
})
```

should fail at compile time.

That preserves the AF-UI contract idea:

> external customization can only rely on functionality the component explicitly promises.

That matters a lot for design-system stability.

---

# A11y fits as another interpreter

Your current `A11y` package/module essentially describes accessibility patterns in terms of required slots, capabilities and events, then validates a View against those contracts.

That ports extremely cleanly.

For instance:

```ts
const DialogPattern = A11y.pattern({
  trigger: Slot.requires({
    capability: Capability.Interactive,
    events: [Event.Click],
  }),

  content: Slot.requires({
    capability: Capability.Container,
  }),
})
```

Then:

```ts
A11y.validate(
  DialogPattern,
  DialogSlots,
)
```

No DOM required.

It's essentially static architectural validation.

I would put that in `foldkit-mixins/a11y` initially, not another npm package.

---

# Style recipes/utilities also port well

Your current utilities like:

```ts
padded(...)
rounded(...)
bordered(...)
textStyle(...)
flexRow(...)
interactive
truncated
```

are just Style data constructors.

Those are almost trivially portable.

And your `styled-composables` pattern—create a headless component then externally attach a style—is exactly the kind of thing this package should enable for Foldkit render helpers.

---

# I would start with one package, not five

My package layout would initially be:

```text
foldkit-mixins
│
├ Slot
├ Slots
├ Mixin
├ Style
├ Theme
├ Behavior
├ Capability
├ Event
├ A11y
└ MountComposition
```

with subpath exports if desirable:

```ts
import { Style } from "foldkit-mixins/style"
import { Behavior } from "foldkit-mixins/behavior"
```

I would **not** immediately make:

```text
foldkit-slots
foldkit-style
foldkit-behavior
foldkit-theme
foldkit-a11y
```

because all of them share the same slot contract and attachment compiler. Splitting them now makes iteration harder.

If Style eventually becomes a serious CSS compiler, then:

```text
foldkit-style
```

could become a real package later.

---

# It should integrate naturally with `foldkit-surface`

This is where the whole `foldkit-plus` architecture gets interesting.

Your current Surface spike already uses Effect Optics, Effect Schema, dependency metadata, projection requirements and restricted `HtmlBuilder` Message universes.

Surface says:

```text
what may this feature observe?
what Messages may it produce?
```

Slots/Mixins say:

```text
what structural attachment points does it expose?
what appearance/interaction may attach there?
```

Together:

```text
                  Feature
                     │
          ┌──────────┴──────────┐
          │                     │
       Surface                 Slots
          │                     │
    ┌─────┴─────┐         ┌─────┴──────┐
    │           │         │            │
 Projection   Messages   Style      Behavior
    │           │         │            │
 what it      what it   how it      how slots
 knows        reports    looks       interact
```

That's an unusually rich description of a UI feature.

---

# Message safety can fall out automatically

This is particularly elegant.

Suppose:

```ts
Surface.view(
  ProjectCard,
  ...
)
```

gives the view:

```ts
HtmlBuilder<
  ChangedProjectName |
  ClickedArchiveProject
>
```

Then a Behavior attached inside that Surface should use that same `HtmlBuilder<Message>`.

So this:

```ts
Behavior.event(
  Event.Click,
  DeletedAccount(),
)
```

simply can't compile if:

```text
DeletedAccount
```

is not in the Surface's Message universe.

We don't need a separate Behavior permission system.

Surface already gives us one.

---

# It could become useful to agents too

Later—not in v1—the combined metadata could expose:

```text
ProjectCard

OBSERVES
Project.name
Project.status

MAY REPORT
ClickedArchiveProject

SLOTS
root        Container
title       Container
archive     Interactive

ATTACHED
ProjectCardStyle
ArchiveButtonBehavior
```

That's effectively a machine-readable semantic UI description.

Given the direction of `foldkit-agent`, that's very appealing.

But I wouldn't couple the package to Agent initially.

---

## The architecture I'd actually build

The core pipeline should be:

```text
                Slots Contract
                     │
        ┌────────────┴─────────────┐
        │                          │
      Style                     Behavior
        │                          │
 pure appearance            declarative attrs
 descriptors                 + Mount fragments
        │                          │
        └────────────┬─────────────┘
                     ▼
                   Mixin
             slot contributions
                     │
                     ▼
              Mixin resolver
                     │
       ┌─────────────┴──────────────┐
       ▼                            ▼
native Foldkit attrs       one composed Mount
Class / Style / Aria /     per element when
OnClick / ChildAttribute   actually necessary
       │                            │
       └─────────────┬──────────────┘
                     ▼
               HtmlBuilder
                     │
                     ▼
                 Foldkit VDOM
```

State never enters this diagram.

Because state remains:

```text
Model / Submodel
      │
      ▼
    view
```

That's the adaptation that makes this properly **Foldkit**, rather than AF-UI transplanted into Foldkit.

My first implementation slice would therefore be very focused: **typed Slots + immutable Mixin descriptors + Style class/inline attachments + declarative Behavior attributes + correct multi-Behavior Mount composition**. Once that works against both ordinary render helpers and real `@foldkit/ui` components, then add Theme/recipes/A11y/richer CSS. That gives you the distinctive inside-out customization model very early without first recreating all of `effect-atom-jsx`.


# Foldkit Plus: Mixins / Styles / Behaviors Implementation Plan

## 1. Summary

Add an inside-out UI composition layer to `doeixd/foldkit-plus`, inspired by the useful parts of `effect-atom-jsx` AF-UI but redesigned around Foldkit's existing architecture.

The new system should let a Foldkit view publish a typed structural contract describing its externally customizable attachment points, then allow independent Styles and Behaviors to attach to those points without copying or forking the view.

The core rule is:

> Extend Foldkit's existing Model → Message → update architecture. Do not create a second state or effect runtime.

The system therefore separates four concerns:

```text
Surface
"What information may this feature observe,
 and what Messages may it produce?"

              │

SlotView
"What structural attachment points
 does this feature expose?"

       ┌──────┴───────┐
       │              │
     Style         Behavior
       │              │
 appearance      interaction
       │              │
       └──────┬───────┘
              │
            Mixin
              │
              ▼
      Foldkit Attributes
         + one Mount
              │
              ▼
         HtmlBuilder
```

Application state remains in Foldkit Model/Submodels.

Remote state remains in `foldkit-remote`.

Observation and Message capability boundaries remain in `foldkit-surface`.

Commands, Subscriptions, ManagedResources, and Mounts retain their existing Foldkit meanings.

---

# 2. Goals

The system should provide:

1. Typed public slot contracts.
2. Capability-based slot compatibility.
3. Typed event and attribute requirements.
4. External style attachment.
5. External behavior attachment.
6. Pipeable Effect-like composition.
7. Deterministic merge semantics.
8. Correct composition of multiple element-scoped Mounts.
9. Integration with ordinary Foldkit views.
10. Integration with `@foldkit/ui`.
11. Integration with `foldkit-surface`.
12. Introspection metadata usable by DevTools and agent packages.
13. SSR/hydration-safe output.
14. Runtime diagnostics for dynamically composed/generated code.
15. Strong type-level negative tests.

It should solve the same broad problems as the AF-UI layer:

```text
Customize without forking.
Compose appearance separately from structure.
Compose behavior separately from structure.
Expose public attachment points deliberately.
Reject invalid attachment at compile time.
Keep all actual application state in one place.
```

---

# 3. Non-goals

The package must not become another frontend runtime.

Specifically, it should not introduce:

* local reactive atoms;
* component-owned hidden state;
* hooks;
* a query cache;
* another normalized remote store;
* automatic network fetching;
* mutable element handles as the default API;
* hidden event buses;
* component-local Effects that mutate application state;
* implicit global registries;
* a second update loop;
* a replacement for `@foldkit/ui`;
* a replacement for Foldkit Commands, Subscriptions, Mounts, or ManagedResources.

A Behavior that needs state uses a Foldkit Model/Submodel.

A network mutation is:

```text
Message
→ update
→ Command / Remote mutation
```

not:

```text
Behavior
→ network
```

A live remote stream remains Remote/Subscription infrastructure.

A DOM-owned effect may use a Mount because its lifetime is actually tied to an element.

---

# 4. Package architecture

Start with three packages.

```text
packages/
├ mixins/
│   foldkit-mixins
│
├ mixins-ui/
│   foldkit-mixins-ui
│
└ mixins-surface/
    foldkit-mixins-surface
```

Do not split Style, Theme, Behavior, A11y, etc. into separate packages initially.

## `foldkit-mixins`

The renderer/Foldkit-facing core.

Contains:

```text
Capability
Event
Attr
Slot
Slots
Mixin
SlotView
Style
Theme
Behavior
Mount composition
A11y
Diagnostics
Introspection
```

Dependencies:

```text
peer:
  effect
  foldkit
```

It should not depend on:

```text
foldkit-surface
foldkit-remote
foldkit-agent
@foldkit/ui
```

This keeps it usable with plain Foldkit.

## `foldkit-mixins-ui`

Adapter package for `@foldkit/ui`.

Depends on:

```text
foldkit-mixins
```

Peers on:

```text
foldkit
effect
@foldkit/ui
```

Contains published slot contracts and ergonomic adapters for official Foldkit UI components.

## `foldkit-mixins-surface`

Bridge between semantic application Surfaces and structural SlotViews.

Depends on:

```text
foldkit-mixins
foldkit-surface
```

It does not create new state or rendering machinery.

It only connects the metadata and typing universes.

---

# 5. Dependency direction

Keep this acyclic:

```text
                 foldkit
                    ▲
                    │
             foldkit-mixins
               ▲         ▲
               │         │
     mixins-ui           mixins-surface
                           ▲
                           │
                    foldkit-surface
                           ▲
                           │
                     foldkit-remote
```

Remote does not know about Mixins.

Mixins does not know about Remote.

Surface is the semantic bridge between them.

That gives the full application flow:

```text
server data
    │
    ▼
foldkit-remote
    │
    ▼
Projection
    │
    ▼
foldkit-surface
    │
 selected model
    ▼
SlotView
    │
    ├── Style
    └── Behavior
    │
    ▼
Foldkit Html
```

---

# 6. Core vocabulary

The public conceptual vocabulary should be small.

```text
Capability
  An abstract structural capability such as
  Container, Interactive, Focusable, TextInput.

Slot
  One named public attachment point.

Slots
  A published structural contract.

Mixin
  A composable set of contributions to Slots.

Style
  A Mixin whose primary contribution is appearance.

Behavior
  A Mixin whose primary contribution is interaction.

SlotView
  A pure Foldkit view that publishes Slots and accepts Mixins.

Theme
  Typed style tokens represented as data.

A11y Pattern
  Requirements a Slots contract should satisfy.
```

The following concepts remain Foldkit concepts:

```text
Model
Message
update
Command
Subscription
Mount
ManagedResource
Submodel
HtmlBuilder
```

---

# 7. Capability model

Port the useful capability hierarchy from AF-UI, but make capabilities structural metadata rather than runtime element handles.

Initial built-ins:

```text
Base
└── Interactive
    ├── Container
    ├── Focusable
    │   └── TextInput
    └── Draggable

Collection
└── Base
```

API:

```ts
const SelectTrigger = Capability.make("SelectTrigger", {
  extends: [Capability.Focusable],
})
```

Capability values should be branded.

Requirements should support inheritance:

```ts
Capability.TextInput
```

must satisfy:

```ts
Capability.Focusable
Capability.Interactive
Capability.Base
```

Use a `Map`, never `{}`, for the runtime capability registry.

No capability name should be vulnerable to object prototype names such as `__proto__`.

---

# 8. Events and attributes

Provide branded metadata tokens.

```ts
Event.Click
Event.Input
Event.Change
Event.Focus
Event.Blur
Event.KeyDown
Event.PointerDown
Event.PointerUp
Event.Hover
Event.Submit
```

and:

```ts
Attr.Role
Attr.AriaLabel
Attr.AriaExpanded
Attr.AriaSelected
Attr.Disabled
Attr.Value
```

Allow custom tokens:

```ts
const Press = Event.make("press")
const AriaFoo = Attr.make("aria-foo")
```

These are metadata.

They do not themselves install handlers.

---

# 9. Slot contracts

The primary authored API:

```ts
const FieldSlots = Slots.define({
  root: Slot.make({
    capability: Capability.Container,
  }),

  label: Slot.make({
    capability: Capability.Container,
  }),

  input: Slot.make({
    capability: Capability.TextInput,
    events: [
      Event.Input,
      Event.Focus,
      Event.Blur,
    ],
    attributes: [
      Attr.AriaLabel,
      Attr.AriaInvalid,
    ],
  }),
})
```

Names come from keys.

Do not repeat:

```ts
name: "input"
```

inside the value.

Every Slot carries runtime metadata plus enough type information for compile-time checking.

Suggested shape:

```ts
interface Slot<
  Name,
  Capability,
  Events,
  Attributes,
  Requirements,
  Hidden,
> {
  readonly name: Name
  readonly capability: Capability
  readonly events: Events
  readonly attributes: Attributes
  readonly requirements: Requirements
  readonly hidden: Hidden
}
```

`hidden` means tooling/internal attachment point, not publicly attachable unless explicitly allowed.

---

# 10. SlotView

`SlotView` is the structural equivalent of Surface.

It does not own state.

It is a pure descriptor around a render function.

Target API:

```ts
const FieldView = SlotView.define(
  FieldSlots,
  (
    input: FieldInput,
    slots,
    h: HtmlBuilder<FieldMessage>,
  ) =>
    h.label(
      slots.root.attrs(),
      [
        h.span(
          slots.label.attrs(),
          [input.label],
        ),

        h.input(
          slots.input.attrs([
            h.Value(input.value),
            h.OnInput(input.onInput),
          ]),
        ),
      ],
    ),
)
```

`slots.input.attrs(base)` resolves:

```text
base Foldkit Attributes
+
attached Style contributions
+
attached Behavior contributions
+
composed Mount
```

The view is still pure.

`SlotView.define` must not run Effects.

`SlotView` should be pipeable:

```ts
const StyledField = FieldView.pipe(
  Style.attach(FieldStyle),
  Behavior.attach(FieldBehavior),
)
```

This is the preferred Effect-like composition model.

---

# 11. Mixin as the common algebra

Style and Behavior should normalize into one internal representation.

Conceptually:

```ts
interface Mixin<Slots, Input, Message> {
  readonly contributions: ContributionMap<Slots, Input, Message>
  readonly metadata: MixinMetadata
}
```

Per slot:

```ts
interface SlotContribution<Input, Message> {
  readonly classes?: ...
  readonly styles?: ...
  readonly attributes?: ...
  readonly events?: ...
  readonly mounts?: ...
}
```

Do not expose the internal normalized form more than necessary.

The important property is:

```text
Style ─────┐
           │
Behavior ──┼──> Mixin contributions
           │
A11y ──────┘
```

which allows one resolver and one conflict policy.

---

# 12. Mixin composition

Core operations:

```ts
Mixin.empty(...)
Mixin.compose(...)
Mixin.mapInput(...)
Mixin.forSlot(...)
Mixin.describe(...)
```

Every descriptor should be immutable and pipeable.

Example:

```ts
const decoration = Mixin.compose(
  FieldStyle,
  FocusBehavior,
  ValidationBehavior,
)
```

Attachment:

```ts
const Field = FieldView.pipe(
  Mixin.attach(decoration),
)
```

Style/Behavior-specific `attach` functions can simply be typed aliases over this core mechanism.

---

# 13. Resolver architecture

The resolver is the most important implementation detail.

Never concatenate arbitrary attribute arrays and hope Snabbdom/Foldkit resolves conflicts the way desired.

Normalize first.

Pipeline:

```text
base attributes
        │
        ▼
attribute decoder
        │
        ▼
NormalizedSlotState
        │
        ├── classes
        ├── styles
        ├── scalar attrs
        ├── properties
        ├── events
        ├── child attributes
        └── mount actions
        │
        ▼
apply Mixin contributions
        │
        ▼
validate ownership/conflicts
        │
        ▼
emit canonical Foldkit attributes
```

This yields deterministic semantics and avoids relying on incidental renderer behavior.

---

# 14. Merge semantics

Define these rules early and test them heavily.

## Classes

Additive.

```text
base classes
→ style A
→ style B
→ explicit final override classes
```

Deduplicate exact class tokens while preserving first occurrence/order unless there is a concrete reason not to.

Emit one final:

```ts
h.Class(...)
```

where practical.

## Inline style

Merge by CSS property.

Attachment order determines precedence:

```ts
View.pipe(
  Style.attach(Base),
  Style.attach(Brand),
  Style.attach(LocalOverride),
)
```

means:

```text
LocalOverride > Brand > Base
```

Protected functional style properties may not be replaced.

Emit one canonical:

```ts
h.Style({...})
```

rather than many competing `Style` attributes.

## Scalar attributes

Base component semantics win by default.

A Mixin attempting to replace an already-owned scalar attribute should produce a conflict unless the Slot contract explicitly permits override.

## Properties

Same rule as scalar attributes.

Controlled properties such as:

```text
value
checked
selected
open
```

should be treated conservatively.

## Events

One semantic owner per native event by default.

Two Behaviors may not silently install two independent `OnClick` handlers.

Conflict should be explicit and diagnosable.

If two operations genuinely follow one user action, Foldkit's preferred solution remains:

```text
one Message
→ update
→ multiple state transitions / Commands
```

Advanced independently composable element listeners belong in Mount-based Behavior contributions.

## ChildAttribute

Treat as opaque.

Never decode/rebuild it.

Preserve its dispatch boundary exactly.

## Key

Structural ownership only.

A Style or Behavior must not override a view key.

## InnerHTML

Structural ownership only.

Do not allow external Mixins to modify it by default.

## OnMount

Never emit more than one `OnMount` for a single final element.

All Mount contributions are composed first.

---

# 15. Protected slot semantics

Allow Slot authors to reserve pieces of behavior.

Possible contract:

```ts
Slot.make({
  capability: Capability.Container,

  protected: {
    events: [Event.Click],
    attributes: [Attr.Role],
    style: ["position"],
  },
})
```

Use sparingly.

The purpose is to let a component expose:

```text
appearance customization
```

without permitting callers to invalidate structural behavior.

Example:

A popover could expose panel background, borders, shadows, spacing, etc. while protecting a positioning property needed by its runtime.

---

# 16. Style core

Target API:

```ts
const FieldStyle = Style.forSlots(
  FieldSlots,
)({
  root: Style.compose(
    Style.class("field"),
    Style.inline({
      display: "grid",
      gap: "0.5rem",
    }),
  ),

  label: Style.class("field-label"),

  input: Style.inline({
    padding: "0.5rem",
    borderRadius: "0.375rem",
  }),
})
```

Core primitives:

```ts
Style.class(...)
Style.inline(...)
Style.compose(...)
Style.when(...)
Style.whenInput(...)
Style.empty
```

All Style values are data.

Do not mutate DOM from Style.

---

# 17. Style recipes and variants

Add typed recipe support after the base resolver works.

Target:

```ts
const ButtonRecipe = Style.recipe({
  base: Style.inline({
    cursor: "pointer",
  }),

  variants: {
    intent: {
      primary: Style.class("button-primary"),
      secondary: Style.class("button-secondary"),
    },

    size: {
      sm: Style.class("button-sm"),
      md: Style.class("button-md"),
      lg: Style.class("button-lg"),
    },
  },

  defaults: {
    intent: "primary",
    size: "md",
  },
})
```

Application:

```ts
ButtonRecipe({
  intent: input.intent,
  size: input.size,
})
```

Variant keys and values must be literal-typed.

Invalid variants are compile-time errors.

---

# 18. Theme

Theme is data, not hidden application state.

Target:

```ts
const Brand = Theme.define({
  color: {
    text: "#161616",
    accent: "#625cff",
    surface: "#ffffff",
  },

  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
  },

  radius: {
    sm: "0.25rem",
    md: "0.5rem",
  },
})
```

Typed references:

```ts
Brand.color.text
Brand.spacing.sm
```

or branded token references if required:

```ts
Brand.token("color", "text")
```

Dynamic theme state such as:

```text
light
dark
high contrast
```

belongs in Foldkit Model.

Example:

```ts
Style.whenInput(
  input => input.theme === "dark",
  DarkStyle,
)
```

Do not use an Atom or hidden mutable Theme service for mode selection.

---

# 19. CSS variables

Theme should preferably compile tokens to CSS variables for dynamic theming.

Example:

```text
--fk-color-text
--fk-color-accent
--fk-spacing-sm
```

`Theme.variables(...)` may produce a Style contribution suitable for the root element.

This provides:

* dynamic theme switching;
* cheap inheritance;
* SSR compatibility;
* no repeated token expansion across the VDOM.

---

# 20. Advanced Style compiler

Do not make the first milestone depend on building a CSS compiler.

Phase one supports:

```text
class names
inline style
CSS variables
conditional composition
recipes
variants
```

After the composition model stabilizes, add a static Style AST capable of:

```text
pseudo selectors
media queries
supports queries
container queries
keyframes
CSS layers
nested selectors
global rules
enter/exit animations
```

These cannot all honestly map to `h.Style`.

The later compiler should:

```text
Style AST
   │
   ▼
canonical serialization
   │
   ▼
stable hash
   │
   ├── deterministic class name
   └── deterministic CSS rules
```

No random IDs.

Server and browser must derive the same result.

If this grows substantial enough, *then* extract:

```text
foldkit-style
```

Do not pre-split it.

---

# 21. Behavior

Behavior means:

> reusable interaction contributions attached to declared Slots.

It does not mean:

> reusable hidden state.

Target:

```ts
const ValidationBehavior =
  Behavior.forSlots(FieldSlots)({
    input: Behavior.slot({
      requires: {
        capability: Capability.TextInput,
        attributes: [Attr.AriaInvalid],
      },

      attributes: ({ input, h }) => [
        h.AriaInvalid(input.invalid),
      ],
    }),
  })
```

For events:

```ts
const FocusBehavior =
  Behavior.forSlots(FieldSlots)({
    input: Behavior.slot({
      requires: {
        events: [Event.Focus],
      },

      attributes: ({ input, h }) => [
        h.OnFocus(input.focused),
      ],
    }),
  })
```

The returned Foldkit attributes must belong to the view's `Message` universe.

---

# 22. Behavior requirement validation

At definition/attachment time validate:

```text
required Slot exists
required capability is satisfied
required event is published
required attribute is published
slot is not hidden
```

Compile-time rejection is the golden path.

Runtime diagnostics remain necessary for generated/dynamic maps.

Readable errors matter.

Prefer:

```text
Behavior requires event 'input' on slot 'root',
but FieldSlots.root does not publish that event.
```

over an unreadable conditional-type dump.

---

# 23. Stateful behaviors

Never create local state inside Behavior.

For something like disclosure:

```text
isOpen
toggle
open
close
```

the implementation is a Foldkit Model/Submodel.

Behavior only supplies the structural attachment layer.

Example:

```text
Disclosure Submodel
      │
publishes attributes
      │
      ▼
trigger Slot
content Slot
```

This means `@foldkit/ui` remains the preferred implementation of stateful accessible widgets.

Mixins customize them.

Mixins do not replace them.

---

# 24. Foldkit Mount integration

This is a major feature.

Foldkit allows one final Mount per element.

Therefore Mixins must compose Mount actions.

Do not invent another lifecycle primitive.

A Behavior may contribute an ordinary Foldkit MountAction:

```ts
const ResizeBehavior =
  Behavior.forSlots(PanelSlots)({
    root: Behavior.mount(
      input => ObserveSize({
        id: input.id,
      }),
    ),
  })
```

`ObserveSize` should itself be defined using Foldkit:

```ts
Mount.define(...)
```

or:

```ts
Mount.defineStream(...)
```

The Mixin layer only composes actions.

---

# 25. Mount composition algorithm

For one resolved Slot:

```text
MountAction A
MountAction B
MountAction C
```

normalize to:

```text
Composite MountAction
```

with:

```ts
f(element, viewStateChanges)
```

that invokes:

```ts
A.f(element, viewStateChanges)
B.f(element, viewStateChanges)
C.f(element, viewStateChanges)
```

inside the same element lifetime and merges their Streams.

The final slot emits exactly:

```ts
h.OnMount(Composite)
```

once.

All original Effect scopes/finalizers remain tied to the final element lifetime.

The composite name must be deterministic.

Example:

```text
Mixins[root](ObserveSize,ObserveVisibility)
```

Composite args should expose nested action metadata for DevTools/tests:

```ts
{
  slot: "root",
  actions: [
    { name: "ObserveSize", args: ... },
    { name: "ObserveVisibility", args: ... },
  ],
}
```

Do not use these names for security decisions.

---

# 26. Mount error handling

Preserve the original Mount stream error types where Foldkit permits them.

Do not swallow defects merely because multiple Mounts are merged.

If Foldkit's public definition APIs constrain normal authored Mounts to `never` failure, keep the public Mixin API aligned with that unless a concrete use case requires widening it.

Probe the pinned Effect/Foldkit `.d.ts` before implementing Stream merging rather than relying on remembered Effect 3 APIs.

---

# 27. Event collision policy

Normal event Behavior:

```ts
h.OnClick(...)
```

uses native Foldkit event Attributes.

If another attached Behavior also claims Click on that Slot:

```text
error
```

by default.

This is intentional.

It prevents:

```text
one browser event
→ multiple unrelated application Messages
```

from becoming an invisible side channel around `update`.

For truly independent element listeners, explicitly opt into:

```text
Behavior.mount(...)
```

using a `Mount.defineStream`.

That makes the extra event source observable as a Foldkit Mount and preserves lifecycle semantics.

---

# 28. A11y patterns

Port the useful structural validation concept.

Target:

```ts
const DialogPattern = A11y.pattern({
  trigger: Slot.requires({
    capability: Capability.Interactive,
    events: [Event.Click],
  }),

  content: Slot.requires({
    capability: Capability.Container,
  }),
})
```

Validation:

```ts
A11y.validate(
  DialogPattern,
  DialogSlots,
)
```

Initial built-ins may include:

```text
Dialog
Tooltip
Popover
Tabs
Combobox
Listbox
Menu
Slider
Calendar
```

Do not claim WCAG certification.

The validator only verifies the contract it actually knows.

---

# 29. `@foldkit/ui` integration

`@foldkit/ui` already uses consumer-owned markup with published attribute groups.

The adapter package should formalize those groups as Slots.

Example contract:

```ts
export const ButtonSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [
      Attr.Role,
      Attr.AriaDisabled,
    ],
  }),
})
```

Then provide helpers that resolve Mixins around the existing `toView` API rather than rewriting Button.

Conceptually:

```ts
Button.view(
  {
    onClick: Saved(),

    toView: attributes => {
      const slots = UiMixins.resolve(
        ButtonSlots,
        attributes,
        mixins,
        input,
        h,
      )

      return h.button(
        slots.button,
        ["Save"],
      )
    },
  },
  h,
)
```

---

# 30. Preserve ChildAttribute

Stateful `@foldkit/ui` Submodels may publish `ChildAttribute`.

The adapter must never:

```text
unwrap
clone
reconstruct
change dispatch
change boundary ownership
```

of those values.

Treat them as opaque preserved values.

This is a hard invariant.

Mixins may surround them with additional ordinary attributes, but never rewrite the ChildAttribute itself.

---

# 31. UI adapter rollout

Do not adapt all components before proving the abstraction.

First:

```text
Button
Input
Checkbox
Disclosure
```

These cover:

```text
stateless interaction
form state
ARIA
controlled values
```

Then:

```text
Dialog
Listbox
Combobox
Menu
Popover
Tabs
Tooltip
Slider
```

These exercise Submodels, ChildAttributes, keyboard handling, focus behavior, Mounts, and more complex slot contracts.

Only after that adapt the full component set.

---

# 32. Surface integration

`foldkit-surface` already answers:

```text
what the feature may observe
what Messages it may produce
```

`foldkit-mixins-surface` should connect a Surface to a SlotView.

Target:

```ts
const ProjectCardView =
  SurfaceView.define(
    ProjectCard,
    ProjectCardSlots,
    (model, slots, h) =>
      h.article(
        slots.root.attrs(),
        [
          h.h2(
            slots.title.attrs(),
            [model.project.name],
          ),

          h.button(
            slots.archive.attrs([
              h.OnClick(
                Message.ClickedArchiveProject({
                  projectId: model.project.id,
                }),
              ),
            ]),
            ["Archive"],
          ),
        ],
      ),
  )
```

Inference:

```text
model
  = ProjectCard's projected model

h
  = HtmlBuilder<ProjectCard.Message>

slots
  = ProjectCardSlots
```

No duplicate type declarations.

---

# 33. Surface Message safety

Behavior attached to a SurfaceView automatically inherits the restricted Surface Message universe.

Therefore this must fail:

```ts
Behavior...
  h.OnClick(Message.DeletedAccount(...))
```

when the Surface does not expose:

```text
DeletedAccount
```

Do not create a separate Behavior authorization system.

Use the already narrowed `HtmlBuilder<Message>`.

This is one of the strongest synergies between Surface and Mixins.

---

# 34. Surface observation safety

Style and Behavior input should be the projected Surface Model, not the entire root Model.

Therefore:

```ts
Style.whenInput(model => ...)
```

and:

```ts
Behavior.attributes(({ input }) => ...)
```

can only inspect fields the Surface projection exposes.

The combined rule becomes:

```text
Surface:
  what this feature can know
  what this feature can say

Slots:
  where this feature can be customized

Style:
  what it can look like

Behavior:
  how those attachment points can react
```

---

# 35. Surface introspection metadata

A `SurfaceView` should expose serializable metadata:

```ts
{
  surface: {
    ...
  },

  ui: {
    slots: {
      root: {
        capability: "Container",
      },

      archive: {
        capability: "Interactive",
        events: ["click"],
      },
    },

    mixins: [
      "ProjectCardStyle",
      "ArchiveBehavior",
    ],
  },
}
```

Functions and closures should not appear in serialized introspection.

Metadata is for:

```text
DevTools
docs
tests
agent descriptions
architecture analysis
```

not runtime authorization.

---

# 36. Remote integration

There should be almost no direct dependency.

That is a feature.

Remote data flows into Surface projections.

Surface projections flow into SlotViews.

Example:

```text
Remote.Model
   │
Project projection
   │
Surface model
   │
SlotView input
```

Style may react to remote state because that state is already part of its input:

```ts
Style.whenInput(
  input => RemoteData.isLoading(input.project),
  LoadingStyle,
)
```

but `foldkit-mixins` should not import `foldkit-remote`.

Application helper packages may provide convenience functions later if repeated patterns emerge.

---

# 37. Remote mutations

A Behavior must never mutate Remote directly.

Correct:

```text
button click
→ Message.ClickedArchiveProject
→ update
→ Remote mutation Command
→ Remote Message
→ update
```

Incorrect:

```text
button Behavior
→ RPC call
→ mutate normalized cache
```

This rule preserves Foldkit's observable transition architecture.

---

# 38. Pagination and live data

No special Mixins integration is necessary.

Remote pagination state can drive:

```text
disabled styles
loading styles
button Messages
visibility
```

Live Remote changes update Model normally, causing the view to re-render.

Mixins remain pure render metadata.

---

# 39. Durable / Sync integration

No package dependency.

`foldkit-durable` and `foldkit-sync` operate on application state and Messages.

Mixins only affect rendering/element-local behavior.

If a behavior produces a Message that the application chooses to replicate, replication happens through the normal application architecture.

Do not make Mixins aware of replication.

---

# 40. Agent integration

Do not make `foldkit-agent` depend on Mixins initially.

Instead provide an introspection descriptor that agent packages may optionally consume.

Useful semantic data:

```text
Surface name
Slot name
Slot capability
accessibility role
human description
available Surface Messages
```

Do not expose CSS internals to agents by default.

Do not turn every Slot into an agent tool.

Agent actions should remain exposed Messages.

The useful result is richer semantic context:

```text
ProjectCard
  observes Project.name/status
  can emit ClickedArchiveProject

  slots:
    title       Container
    archive     Interactive
```

not:

```text
click DOM node #347
```

---

# 41. DevTools integration

After core stability, expose metadata that can support:

```text
Surface: ProjectCard
Slot: archive
Capability: Interactive

Base attributes:
  type=button

Style:
  ProjectCardStyle
  intent=danger

Behavior:
  ArchiveButtonBehavior

Mounts:
  none

Message universe:
  ClickedArchiveProject
```

For Mount composition show nested actions:

```text
root
  Composite Mount
    ObserveSize
    ObserveVisibility
```

This makes external composition inspectable instead of magical.

---

# 42. Diagnostics

Create stable codes.

Examples:

```text
mixins:unknown-slot
mixins:hidden-slot
mixins:capability-mismatch
mixins:unsupported-event
mixins:unsupported-attribute
mixins:event-conflict
mixins:attribute-conflict
mixins:protected-attribute
mixins:protected-style-property
mixins:duplicate-mount-name
style:unsupported-property
a11y:missing-slot
a11y:capability-mismatch
```

Diagnostics should be data:

```ts
interface Diagnostic {
  source: string
  code: string
  severity: "error" | "warning"
  message: string
  slot?: string
  details?: unknown
}
```

This lets tests, CLI tooling, DevTools, and future editor tooling share them.

---

# 43. Platform model

Do not overbuild cross-platform rendering in v1.

However Slots should remain renderer-neutral metadata.

Eventually:

```ts
Platform.define({
  name: "web",

  capabilities: [...],
  events: [...],
  attributes: [...],
  styleProperties: [...],
})
```

can validate a Slots/Style graph.

The first implementation only needs the Web/Foldkit platform.

Do not ship a fake TUI/native renderer just to claim platform independence.

---

# 44. SSR and hydration

Every render-affecting operation must be deterministic.

Prohibit:

```text
random class names
Date.now-based identifiers
incrementing global IDs that differ server/client
unordered object traversal where output identity depends on order
```

Style hashing must be based on canonical serialized Style data.

Conditional Style must depend on explicit render input.

Theme mode affecting first render must come from Model/Flags in the same way other Foldkit state does.

Element-scoped Mount work occurs client-side through normal Foldkit lifecycle.

---

# 45. Proposed package file layout

```text
packages/mixins/
├ package.json
├ tsconfig.json
├ tsdown.config.ts
├ README.md
├ DESIGN.md
├ LICENSE
│
├ src/
│  ├ index.ts
│  │
│  ├ capability.ts
│  ├ metadataToken.ts
│  ├ event.ts
│  ├ attr.ts
│  │
│  ├ slot.ts
│  ├ slots.ts
│  │
│  ├ mixin.ts
│  ├ contribution.ts
│  ├ resolver.ts
│  ├ slotView.ts
│  │
│  ├ behavior/
│  │  ├ index.ts
│  │  ├ behavior.ts
│  │  ├ slotBehavior.ts
│  │  ├ mount.ts
│  │  └ composeMounts.ts
│  │
│  ├ style/
│  │  ├ index.ts
│  │  ├ style.ts
│  │  ├ ast.ts
│  │  ├ compose.ts
│  │  ├ recipe.ts
│  │  ├ theme.ts
│  │  ├ tokens.ts
│  │  └ compile.ts
│  │
│  ├ a11y.ts
│  ├ diagnostics.ts
│  └ introspect.ts
│
└ test/
   ├ capability.test.ts
   ├ capability.test-d.ts
   ├ slots.test.ts
   ├ slots.test-d.ts
   ├ resolver.test.ts
   ├ resolver.test-d.ts
   ├ style.test.ts
   ├ style.test-d.ts
   ├ recipe.test.ts
   ├ behavior.test.ts
   ├ behavior.test-d.ts
   ├ mount.test.ts
   ├ slotView.test.ts
   ├ slotView.test-d.ts
   ├ a11y.test.ts
   └ fixture.ts
```

Adapters:

```text
packages/mixins-ui/
├ src/
│  ├ index.ts
│  ├ button.ts
│  ├ input.ts
│  ├ checkbox.ts
│  ├ disclosure.ts
│  └ ...
└ test/

packages/mixins-surface/
├ src/
│  ├ index.ts
│  ├ surfaceView.ts
│  └ introspect.ts
└ test/
```

---

# 46. Public exports

Keep the root clean:

```ts
export {
  Capability,
  Event,
  Attr,
  Slot,
  Slots,
  Mixin,
  SlotView,
  Style,
  Theme,
  Behavior,
  A11y,
  Diagnostics,
}
```

Do not export internal AST/compiler machinery unless consumers have a real reason to use it.

Prefer namespace-style APIs matching Effect/Foldkit conventions.

---

# 47. Package metadata

During implementation:

```json
{
  "name": "foldkit-mixins",
  "version": "0.0.0",
  "private": true,
  "sideEffects": false
}
```

Peers:

```json
{
  "effect": "^4.0.0-rc.112",
  "foldkit": "^0.158.2"
}
```

Use the same tsdown/tsconfig patterns as Surface and Remote.

Once API shape survives real examples and type tests, make it public and version it alongside the other ecosystem packages.

---

# 48. Phase 0 — implementation probes

Before public API work, write scratch probes against the installed versions.

Verify:

```text
Foldkit Attribute tagged representation
Class duplicate behavior
Style duplicate behavior
event duplicate behavior
ChildAttribute runtime shape
OnMount runtime shape
Scene Mount inspection
Mount.defineStream types
Effect Stream merge APIs in rc.112
HtmlBuilder inference behavior
Submodel child attribute boundaries
SSR serialization of Style/Class combinations
```

Do not base the resolver on assumptions.

Write conclusions into `packages/mixins/DESIGN.md`.

No production abstractions yet.

---

# 49. Phase 1 — Capability, Event, Attr, Slot, Slots

Implement metadata-only primitives.

Acceptance criteria:

```text
custom capabilities inherit correctly
TextInput satisfies Interactive
invalid capability does not
__proto__ works safely as a custom name
Slot names infer from object keys
unknown Slots keys reject
hidden slots remain represented
metadata is serializable
all values are pipeable where useful
```

Add positive and negative `.test-d.ts` cases immediately.

---

# 50. Phase 2 — Mixin and resolver

Implement the internal contribution model.

Support:

```text
classes
inline styles
scalar attrs
properties
event attrs
ChildAttributes
MountActions
```

Implement deterministic merge/conflict policy.

Acceptance criteria:

```text
class composition deterministic
style property precedence deterministic
scalar conflicts rejected
event conflicts rejected
ChildAttribute survives by identity
Key cannot be externally overridden
one final OnMount maximum
resolve is pure
```

Mutation-test the important conflict branches.

---

# 51. Phase 3 — SlotView

Implement pure `SlotView.define`.

Target API should work before Style/Behavior are sophisticated.

Acceptance criteria:

```text
view receives strongly typed slot builders
wrong Slot name fails
wrong Message fails
base attrs round-trip
Mixin attachment pipe works
no runtime state is created
plain Foldkit view output remains normal Html
```

Add a small Field example.

---

# 52. Phase 4 — Style v1

Implement:

```text
Style.class
Style.inline
Style.compose
Style.when
Style.whenInput
Style.forSlots
Style.attach
```

Acceptance criteria:

```text
unknown slots reject
styles compose
last attachment wins per style property
classes concatenate
conditions use explicit Input
protected properties reject override
no Effects run
```

Do not implement pseudo/media compiler yet.

---

# 53. Phase 5 — Theme and recipes

Implement:

```text
Theme.define
typed token paths
CSS variable generation
Style.recipe
typed variants
defaults
compound variants only if actually needed
```

Acceptance criteria:

```text
invalid token fails
invalid variant fails
theme state remains caller-owned
server/browser token output deterministic
recipe output is just Style data
```

---

# 54. Phase 6 — Behavior v1

Implement:

```text
Behavior.slot
Behavior.forSlots
Behavior.attributes
Behavior.attach
Behavior.compose
requirement metadata
```

Acceptance criteria:

```text
capability mismatch rejects
undeclared event rejects
undeclared attr rejects
Surface-style narrowed HtmlBuilder Message unions remain preserved
two owners for one event conflict
Behavior creates no state
```

Add Disclosure-like examples using external Model rather than Behavior-local state.

---

# 55. Phase 7 — Mount composition

Implement:

```text
Behavior.mount
MountAction collection
composite MountAction creation
Stream merging
nested metadata
```

Acceptance criteria:

```text
two Behavior Mounts produce one h.OnMount
both streams can emit Messages
both lifetimes end on unmount
all finalizers run
composite is deterministic
time-travel semantics remain Foldkit-owned
Scene can observe/resolve the resulting Mount
```

Test:

```text
unmount
re-render without replacement
keyed reorder
historical render
interruption
one Mount failure/defect
```

where the public Foldkit API permits.

---

# 56. Phase 8 — A11y and diagnostics

Implement structural validation.

Acceptance criteria:

```text
missing slot reported
capability mismatch reported
missing event reported
hidden slot reported
diagnostic code stable
same diagnostics usable by tests and tooling
```

Keep this independent of DOM.

---

# 57. Phase 9 — `@foldkit/ui` adapter

Start with:

```text
Button
Input
Checkbox
Disclosure
```

Verify the abstraction on real Foldkit UI instead of toy fixtures.

Critical acceptance tests:

```text
base accessibility attrs survive
base event Messages still dispatch
ChildAttribute survives untouched
Style can customize published slots
Behavior cannot steal owned event silently
controlled values remain controlled
```

Then expand to stateful Submodel components.

---

# 58. Phase 10 — Surface adapter

Implement:

```ts
SurfaceView.define(...)
```

and metadata composition.

Acceptance criteria:

```text
Surface projected Model inferred
Surface Message union inferred
Behavior cannot emit out-of-Surface Message
Style/Behavior cannot see root Model outside projection
Slot metadata appears in introspection
Surface registry remains independent of rendering runtime
```

Add type tests modeled after existing Surface `.test-d.ts` coverage.

---

# 59. Phase 11 — Remote-backed example

Build one worked application that uses:

```text
foldkit-remote
foldkit-surface
foldkit-mixins
```

Example:

```text
Project list
Project card
pagination
live status
rename mutation
archive mutation
loading/error states
```

Use:

```text
Remote
→ Surface projection
→ SurfaceView
→ Styles/Behaviors
```

This is an integration proof, not a dependency between Remote and Mixins.

---

# 60. Phase 12 — advanced Style compiler

Only after the core survives real use, implement:

```text
pseudo
media
supports
container
nest
keyframes
layers
global
animations
```

Requirements:

```text
deterministic canonical AST
stable class hashes
SSR collection
hydration equality
deduplicated rule registry
no import-time DOM mutation
no random IDs
```

At this phase decide whether Style deserves its own package.

Do not decide earlier.

---

# 61. Phase 13 — DevTools / agent metadata

Expose serializable inspection descriptors.

For agent integration, add optional consumption in agent tooling rather than a dependency from Mixins to Agent.

Potential agent representation:

```text
ProjectCard
  observes:
    project.id
    project.name
    project.status

  actions:
    ClickedArchiveProject

  UI:
    root: Container
    title: Container
    archive: Interactive
```

Do not expose style implementation details unless explicitly requested.

---

# 62. Type testing strategy

Every type constraint gets both acceptance and rejection cases.

Examples:

```ts
// valid
Behavior requiring Interactive
→ TextInput Slot

// @ts-expect-error
Behavior requiring TextInput
→ Container Slot
```

Also negative cases for:

```text
unknown Slot
hidden Slot
unsupported event
unsupported attribute
invalid Theme token
invalid recipe variant
wrong Surface Message
wrong Surface model field
wrong @foldkit/ui adapter contract
```

Never consider a constraint covered by positive inference tests alone.

---

# 63. Runtime testing strategy

Use Vitest for pure descriptor/resolver tests.

Use Foldkit Scene where possible for actual view/message behavior.

Test real runtime behavior rather than mocks of the assumptions being tested.

Important runtime suites:

```text
resolver
Mount composition
ChildAttribute preservation
SlotView rendering
style precedence
UI adapter integration
Surface adapter integration
SSR determinism
```

For every important test, temporarily mutate the implementation and confirm the test fails before considering it useful.

---

# 64. Performance requirements

Definition-time work should happen once.

At render time:

```text
do not recompute capability graphs
do not repeatedly validate static contracts
do not parse the same static Style AST
do not allocate unnecessary metadata objects
```

Precompile static Mixin descriptors.

Resolver hot path should mostly be:

```text
read conditional values
merge small attribute records
emit Foldkit Attributes
```

Use Maps for indexed registries.

Cache static Style compilation by descriptor identity where useful.

---

# 65. Security boundaries

Slot contracts are not authorization.

Surface Message sets are not automatically authorization either.

Agent exposure remains governed by explicit agent authorization.

Do not expose arbitrary DOM selectors or element references through agent metadata by default.

Dynamic/generated contracts must be validated before being trusted by tooling.

Never interpret style data as executable JavaScript.

If advanced CSS supports raw escape hatches, clearly separate safe typed APIs from unsafe/raw APIs.

---

# 66. Naming

Recommended package:

```text
foldkit-mixins
```

Recommended concepts:

```text
Slot
Slots
Mixin
SlotView
Style
Behavior
Theme
A11y
Capability
```

Avoid introducing:

```text
Component
Hook
Action
Binding
Atom
Signal
```

for this layer because Foldkit already has clearer ownership semantics.

`Behavior` is acceptable only if the docs repeatedly establish:

```text
Behavior does not own application state.
```

---

# 67. Example end-state

A complete feature could look like:

```ts
const ProjectCardSlots = Slots.define({
  root: Slot.make({
    capability: Capability.Container,
  }),

  title: Slot.make({
    capability: Capability.Container,
  }),

  status: Slot.make({
    capability: Capability.Container,
  }),

  archive: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
  }),
})

const ProjectCardStyle =
  Style.forSlots(ProjectCardSlots)({
    root: Style.compose(
      Style.class("project-card"),
      Style.inline({
        display: "grid",
        gap: "0.75rem",
      }),
    ),

    archive: Style.recipe({
      base: Style.class("button"),

      variants: {
        status: {
          active: Style.class("button-danger"),
          archived: Style.class("button-disabled"),
        },
      },
    }),
  })

const ProjectCardBehavior =
  Behavior.forSlots(ProjectCardSlots)({
    archive: Behavior.slot({
      requires: {
        events: [Event.Click],
      },

      attributes: ({ input, h }) =>
        input.project.status === "archived"
          ? [h.AriaDisabled(true)]
          : [],
    }),
  })

const ProjectCardView =
  SurfaceView.define(
    ProjectCard,
    ProjectCardSlots,
    (model, slots, h) =>
      h.article(
        slots.root.attrs(),
        [
          h.h2(
            slots.title.attrs(),
            [model.project.name],
          ),

          h.span(
            slots.status.attrs(),
            [model.project.status],
          ),

          h.button(
            slots.archive.attrs([
              h.OnClick(
                Message.ClickedArchiveProject({
                  projectId: model.project.id,
                }),
              ),
            ]),
            ["Archive"],
          ),
        ],
      ),
  ).pipe(
    Style.attach(ProjectCardStyle),
    Behavior.attach(ProjectCardBehavior),
  )
```

The system can understand this feature at several levels:

```text
Remote:
  where Project data comes from

Surface:
  ProjectCard may observe selected Project fields
  ProjectCard may emit ClickedArchiveProject

Slots:
  root/title/status/archive are public attachment points

Style:
  appearance of those points

Behavior:
  additional permitted interaction semantics

Foldkit:
  actual Message → update transition
```

That is the architecture to preserve.

---

# 68. Commit sequence

Follow the repository's small-commit discipline.

Suggested sequence:

```text
1. chore(mixins): add package skeleton
2. feat(mixins): add metadata tokens and capabilities
3. feat(mixins): add Slot and Slots contracts
4. test(mixins): add capability/slot negative type tests
5. feat(mixins): add Mixin contribution model
6. feat(mixins): add deterministic resolver
7. feat(mixins): add SlotView
8. feat(mixins): add Style core
9. feat(mixins): add Theme and recipes
10. feat(mixins): add Behavior contracts
11. feat(mixins): add Mount composition
12. feat(mixins): add A11y diagnostics
13. feat(mixins-ui): adapt Button/Input/Checkbox/Disclosure
14. feat(mixins-surface): add SurfaceView
15. example: add remote/surface/mixins example
16. docs: document architecture and rules
17. feat(style): advanced stylesheet compiler
18. feat(tooling): add introspection consumers
```

After every coherent commit:

```text
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

and run relevant demos/examples.

---

# 69. Definition of done for first publishable release

`foldkit-mixins` is ready for its first public prerelease when all of these are true:

```text
Slots are typed and stable.
Capability inheritance works.
SlotView is pure and ergonomic.
Style class/inline/conditional composition works.
Theme tokens and variants work.
Behavior requirements are type-safe.
Behavior owns no hidden state.
Event conflicts are deterministic.
Multiple Mount contributions become exactly one Foldkit Mount.
ChildAttribute survives unchanged.
At least four @foldkit/ui components are adapted.
SurfaceView correctly narrows Model and Message.
A Remote-backed example works end-to-end.
Runtime and negative type tests cover public invariants.
SSR output is deterministic.
README clearly explains ownership boundaries.
No second state/effect/rendering runtime exists.
```

---

# 70. Longer-term result

Once Surface, Remote, and Mixins are all established, `foldkit-plus` gains a coherent architecture from storage all the way through interaction:

```text
                     DOMAIN DATA
                         │
                         ▼
                   foldkit-remote
               normalized server state
                         │
                         ▼
                  foldkit-surface
             observation + capabilities
                         │
                         ▼
                     SlotView
                  structural API
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
        Style                        Behavior
     appearance                    interaction
          │                             │
          └──────────────┬──────────────┘
                         ▼
                       Mixin
                         │
                         ▼
                Foldkit Attributes
                  + Mount lifecycle
                         │
                         ▼
             Model · Message · update
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
          Commands              Submodels/etc.
```

The important architectural property is that none of these layers competes with another.

Remote owns remote data.

Surface owns semantic observation/capability boundaries.

Mixins owns structural customization.

Foldkit owns application transitions and lifecycle.

That makes the new layer feel like a missing Foldkit ecosystem primitive rather than an additional frontend framework sitting on top of Foldkit.

Yes. I think the important conclusion is that **this is much closer to an adaptation than a rewrite**, and it should compose cleanly with Foldkit because the two libraries solve different layers of the problem.

`effect-atom-jsx` already has a lot of the hard **type algebra and descriptor design** we want. Its `View.ts` contains branded event/attribute/requirement tokens, slot metadata, capability-aware slot typing, readable compile-time error machinery, pipeable descriptors, remapping concepts, and runtime diagnostics. None of that fundamentally depends on Atom state.  Likewise, the Style system is already largely a data AST—slot pieces, conditional pieces, responsive/media/supports/container/pseudo pieces, vars, animations, layers, global rules, etc.—which is exactly the kind of code we want to preserve.

The split I’d make is roughly:

| `effect-atom-jsx` area              | Foldkit reuse                    |
| ----------------------------------- | -------------------------------- |
| `MetadataToken`                     | **Almost direct reuse**          |
| Capability hierarchy                | **Almost direct reuse**          |
| `View.Slot` / `View.Slots` typing   | **Heavy reuse/adaptation**       |
| readable type-error machinery       | **Direct reuse**                 |
| Event/Attribute/Requirement tokens  | **Direct reuse**                 |
| diagnostics                         | **Heavy reuse**                  |
| `A11y` contracts/catalog            | **Heavy reuse**                  |
| Style AST                           | **Heavy reuse**                  |
| style token/type definitions        | **Heavy reuse**                  |
| recipes/style utilities             | **Heavy reuse**                  |
| Theme token definitions             | **Heavy reuse, runtime changed** |
| `Behavior` metadata/type validation | **Partial reuse**                |
| `Behavior.run(elements)` runtime    | **Rewrite**                      |
| behavior bindings/event bus         | **Mostly remove**                |
| `Element.Handle` runtime            | **Mostly remove**                |
| `Component` runtime                 | **Remove**                       |
| Atom state machinery                | **Remove**                       |
| JSX attachment/context runtime      | **Rewrite as Foldkit resolver**  |

The strongest direct reuse candidate is actually the slot system. Today AF-UI already has exactly the ideas we want: a renderer-neutral Slot has a capability, allowed events, allowed attributes, platform requirements, visibility, and readable compile-time errors for incompatible attachments.  For Foldkit, you mostly change what a slot resolves **to**. Instead of:

```ts
Slot
→ Element.Handle
```

you make it:

```ts
Slot
→ Foldkit attribute contribution point
```

So I'd consider extracting/generalizing a lot of that code nearly mechanically.

The Style side may be even more reusable. AF-UI's Style is already explicitly modeled as **data rather than DOM mutation**.  That's ideal. Much of:

```ts
Style.compose(...)
Style.slot(...)
Style.media(...)
Style.pseudo(...)
Style.vars(...)
Style.container(...)
Style.layer(...)
Style.recipe(...)
```

can potentially survive with only its final interpreter swapped:

```text
effect-atom-jsx

Style AST
   ↓
resolve against Element.Handle
   ↓
DOM/runtime styling
```

becomes:

```text
foldkit-mixins

same/similar Style AST
   ↓
compile
   ↓
h.Class / h.Style / generated stylesheet
```

That's exactly the kind of reuse you want: **keep the language, replace the interpreter**.

Theme is similar. Your existing Theme code is mostly typed token definitions, lookup, and resolution; the part that doesn't belong is its Atom-backed mutable mode.  So:

```ts
Theme.define(...)
Theme.defineTokens(...)
lookupToken(...)
token path types
```

can largely move over, while:

```ts
mode: Atom.ReadonlyAtom<"light" | "dark">
```

becomes caller-owned Foldkit Model state or CSS-variable state.

Behavior is where less implementation code transfers. Current AF-UI Behavior fundamentally means:

```ts
run:
  Elements
    → Effect<Bindings, Error, Requirements>
```

and can publish bindings and its own typed event bus.  That is very intentionally a mini composition/runtime layer. Foldkit already has better homes for those responsibilities:

```text
Bindings/state    → Model / Submodel
Out-event bus     → Message
Effect after fact → Command
external stream   → Subscription
element lifetime  → Mount
```

So we should reuse the **type-level requirement machinery** from Behavior:

```text
which slots?
which capabilities?
which events?
what metadata?
can this behavior attach here?
```

but rewrite execution into Foldkit-native contributions:

```ts
Behavior.slot({
  attributes: ...
  mount: ...
})
```

rather than:

```ts
Behavior.make(elements =>
  Effect<Bindings>
)
```

That distinction is what keeps it from becoming a second runtime.

And Foldkit already gives us very good attachment primitives. `Attribute<Message>` is an actual tagged data type covering class, style, properties, ARIA, events, `OnMount`, etc.  So the target of the mixin compiler is not some awkward adapter API—it is Foldkit's native view language.

Even better, `@foldkit/ui` already uses the exact **inside-out customization style** this needs. Its components can publish groups of attributes for consumer-owned markup, and Foldkit's `ChildAttribute` machinery exists specifically to preserve the originating Submodel's dispatch boundary when such attributes are spread into a parent's element.

So the new package isn't fighting Foldkit UI. It's formalizing and expanding a pattern Foldkit already uses:

```text
@foldkit/ui today

Component
   ↓
published attribute group
   ↓
consumer markup
```

becomes:

```text
Component / SlotView
        ↓
   typed Slots
        │
   ┌────┴────┐
 Style    Behavior
   └────┬────┘
        ↓
resolved attribute group
        ↓
 consumer markup
```

`ChildAttribute` can just flow through the resolver opaquely.

There is also a surprisingly nice fit with Mount. AF-UI Behavior can independently acquire scoped element listeners/resources. Foldkit's corresponding primitive is `Mount`, whose action already gets the live element, produces a `Stream<Message>`, gets an Effect Scope tied to element lifetime, and understands Foldkit's time-travel semantics.  The only mismatch is that Foldkit wants one effective Mount per element. That means our resolver needs to combine several mixin Mount contributions into a single Mount action—but that's a localized interpreter problem, not an architectural conflict.

And then Surface makes it fit even more tightly. Your actual `foldkit-surface` work already uses Effect Optics, Schema, projected Models, dependency metadata, and—critically—a narrowed `HtmlBuilder<Message>` based on the Surface's allowed Messages.  So a Behavior attached inside:

```ts
SurfaceView.define(
  ProjectCard,
  ProjectCardSlots,
  ...
)
```

can simply receive that same narrowed builder.

That means the compiler gets this for free:

```text
Behavior
tries to create
h.OnClick(DeletedAccount())
       │
       ▼
DeletedAccount not in Surface.Message
       │
       ▼
TypeScript error
```

No new capability-security type system.

So the layers compose almost perfectly:

```text
Effect primitives
│
├ Optic
├ Schema
├ Effect / Stream / Scope
└ ...
        │
        ▼
      Foldkit
 Model · Message · update
 Attributes · Mount · Submodel
        │
        ├──────────────────┐
        ▼                  ▼
 foldkit-surface      foldkit-remote
 semantic boundary   remote data
        │
        ▼
    SlotView
        │
 ┌──────┴───────┐
 ▼              ▼
Style        Behavior
 │              │
 └──────┬───────┘
        ▼
      Mixin
        ▼
native Foldkit Attributes
        ▼
     HtmlBuilder
```

I wouldn't promise a specific code-reuse percentage until actually doing the extraction, because `View.ts`, `Style.ts`, and `Behavior.ts` currently import AF-UI-specific pieces in places. But my expectation would be:

**Conceptual/design reuse: very high, probably 70–90%.**

**Pure type/data utility code reuse: substantial, perhaps 50%+ of the relevant AF-UI slot/style/a11y modules.**

**Runtime reuse: much lower**, intentionally, because the runtime should become Foldkit's Attributes/Mount/Submodel machinery rather than preserve `Element.Handle`, Atom, and Component.

That's actually the ideal situation. You don't want to maintain two unrelated implementations of concepts like:

```text
Capability
MetadataToken
Slot contract
Style AST
Theme token types
A11y pattern
diagnostics
```

I'd seriously consider extracting those **renderer/state-runtime-neutral pieces into shared internal source modules** or a tiny lower-level package eventually, so `effect-atom-jsx` and `foldkit-mixins` literally share the algebra rather than copy-pasting it.

Something like:

```text
@doeixd/ui-core   ← maybe later, not necessarily published
│
├ MetadataToken
├ Capability
├ Slot contracts
├ Style AST
├ Theme tokens
├ A11y contracts
└ Diagnostics
       │
       ├─────────────────┐
       ▼                 ▼
effect-atom-jsx     foldkit-mixins
       │                 │
Atom / handles      Attributes / Mount
Component runtime   Foldkit state machine
```

I would **not extract that first**, though. Build `foldkit-mixins` by adapting the existing code, see exactly what remains runtime-neutral after the second implementation exists, and only then deduplicate. Otherwise you'll accidentally design an abstract "UI core" around assumptions from one renderer.

So yes: **this should be relatively easy to integrate with Foldkit, and it is one of the rare cases where there is genuinely a lot of useful existing code to reuse rather than just similar concepts.** The key is to reuse the *algebra* aggressively while deliberately replacing the AF-UI runtime with Foldkit's native primitives.
