# `foldkit-mixins`

Inside-out Style/Behavior attachment for Foldkit. A view publishes a typed
slot contract; Style and Behavior attach to those slots without forking the
view. Application state stays in Model/Submodel. This package does not grow
a second runtime.

Authoritative product plan: root `SLOT_MIXIN_STYLE_BRAINSTORM.md`. This file
records substrate probes and the decisions they force. Where they conflict,
this file wins for implementation.

**Thesis:** whenever Foldkit already has a lawful primitive, compile onto it.

## Package

`foldkit-mixins`, private `0.0.0`. Peers: `effect@^4.0.0-rc.112`,
`foldkit@^0.158.2`. No dependency on Surface, Remote, Agent, or `@foldkit/ui`.

Adapters (`foldkit-mixins-ui`, `foldkit-mixins-surface`) come after the core
resolver works.

## Phase 0 probes (foldkit 0.158.2, effect rc.112)

Run from this package, not the repo root:

```
pnpm exec tsx probe/foldkit.ts
```

Checked against the installed `.d.ts` and by constructing real VNodes.

### Attribute representation

`Attribute<Message>` is a `Data.TaggedEnum`. Public constructors live on
`HtmlBuilder` (`h.Class`, `h.Style`, `h.OnClick`, …). Observed shapes:

```text
{ _tag: 'Class', value: 'field' }
{ _tag: 'Style', value: { display: 'grid' } }
{ _tag: 'Key',   value: 'row-1' }
```

The public `foldkit/html` surface is small: `inertHtml`, `childAttributes`,
and a handful of option schemas. `__htmlBuilder`, `__setRuntime`,
`FOLDKIT_MOUNT_KEY`, and `isChildAttribute` are **not** public. Mixins take
the view's `h` as a parameter and emit ordinary `Attribute | ChildAttribute`
arrays. Library-level handler-free bundles may use `inertHtml`.

### Duplicate Class — last Class wins, no merge

`h.Class('a b')` then `h.Class('c')` yields vnode `class: { c: true }`.
`serializeHtml` emits `class="b"`. Foldkit replaces the class object; it
does not concatenate tokens.

**Resolver rule:** emit one `h.Class(...)` after concatenating and
deduplicating tokens.

### Duplicate Style — last Style wins the whole object

`h.Style({ color: 'red', padding: '1px' })` then `h.Style({ color: 'blue' })`
yields `{ color: 'blue' }`. Padding is gone. `serializeHtml` agrees.

**Resolver rule:** merge by CSS property in attachment order, then emit one
`h.Style({...})`. Last attachment wins a given property.

### Duplicate OnClick — Foldkit chains, Mixins must not rely on that

Two `h.OnClick` attributes on one element both dispatch, in registration
order, through their own dispatchers. Foldkit's html builder chains
`data.on.click` so Submodel `ChildAttribute` handlers survive a parent
spread. An earlier handler that throws skips later ones.

The Mixins event policy is stricter: two Behaviors may not silently own one
semantic event. Detect the conflict **before** emitting. If the resolver
emits two `OnClick`s, Foldkit will chain them and the conflict is lost.

Independent element listeners that genuinely need to coexist belong in
`Behavior.mount` / `Mount.defineStream`, not a second `OnClick`.

### Duplicate OnMount — last marker, replaced insert hook

Two `h.OnMount` attributes: `data.foldkitMount.name` is the **second**
action. Scene therefore sees one Mount. The insert/postpatch hooks are
replaced, not composed (destroy is chained to a previous destroy).

**Resolver rule:** collect MountActions per slot, merge their streams into
one `MountAction`, emit one `h.OnMount`. Composite name is deterministic,
e.g. `Mixins[root](ObserveSize,ObserveVisibility)`. Nested action metadata
goes in `args` for DevTools/Scene, never for authorization.

### ChildAttribute — opaque, identity-preserving

`childAttributes` is public. Each item is branded with `__childAttribute`
and carries `{ attribute, dispatch, resolveUnmount, boundaryMappers }`.
Groups that contain `OnMount` also carry `resolveMountDispatch`. The inner
`attribute` is the original object (same reference). `isChildAttribute` is
not public; detect with the brand key.

Spreading a child `OnClick` next to a parent `OnClick` dispatches **both**,
each through its captured dispatcher.

**Resolver rule:** never unpack, clone, or rebuild a ChildAttribute. Treat
it as an opaque preserved value. Mixins may surround it with ordinary
attributes. Submodel ownership survives automatically.

### HtmlBuilder

Invariant in `Message` (Surface Phase 0 already recorded this). Mixins do
not invent a second permission system: a Behavior attached inside a
SurfaceView uses that view's `HtmlBuilder<SurfaceMessage>`.
`__htmlBuilder` stays an internal Foldkit seam; SlotView receives `h`.

### Mount public API

`foldkit/mount` exports `define`, `defineStream`, `liveViewStateChanges`,
`mapMessage`. `MountAction` is `{ name, args?, f(element, viewStateChanges) => Stream<Message, E> }`.
Authored `define` / `defineStream` constrain execute failure to `never` and
require at least one result Message schema. Mixins public Mount helpers
stay aligned with that unless a concrete case needs widening.

`OnMount` binds `insert`/`destroy` only. Args are captured at mount, not
refreshed across renders.

### Stream merge (rc.112)

`Stream.mergeAll(streams, { concurrency: 'unbounded' })` is the N-way merge.
A failing inner stream fails the merge (`Effect.result` is `Failure`); it is
not swallowed. `Stream.merge` additionally takes
`haltStrategy?: 'left' | 'right' | 'both' | 'either'`. Default: both sides
must end. Composite Mounts use `mergeAll` with unbounded concurrency and
leave failures typed.

### SSR

`serializeHtml` emits attrs, class, props, then inline style. Event handlers
and hooks are skipped. Duplicate Class/Style last-wins in markup too, so
the resolver's single-Class / single-Style emit is what keeps SSR
deterministic. `renderToString` is a full application entry; Mixins do not
call it. No random class names, no `Date.now` ids.

### Capability registry

`__proto__` is a legal custom name. Lookups go through a `Map`, never `{}`.

## Merge policy (resolver, Phase 2)

| Kind | Policy |
| --- | --- |
| Class tokens | Additive, first-occurrence order, one `h.Class` |
| Inline style | Per-property, last attachment wins, one `h.Style` |
| Scalar attrs / props | Base view owns; Mixin replace is a conflict unless the Slot permits override |
| Controlled props (`value`, `checked`, `selected`, `open`) | Conservative; treat as owned |
| Events | One semantic owner; conflict is an error |
| ChildAttribute | Opaque, preserve identity |
| Key, InnerHTML | Structural ownership; Mixins may not override |
| OnMount | Compose first; one final `OnMount` |

Protected Slot pieces (`events`, `attributes`, `style` properties) reject
override even when a later attachment would otherwise win.

### Resolver decisions

- Attributes are classified by `_tag`. `On*` (except `OnMount`) are events,
  `OnMount` contributes a MountAction, `Class`/`Style` are decomposed into the
  canonical class/style merge, and `Key`/`InnerHTML` are structural.
- Ownership is by tag, except `Prop`, `Attribute`, `DataAttribute`
  (tag + `key`) and `OnCustomEvent` (tag + `name`), so distinct keys do not
  falsely conflict.
- Event tags normalize to token names by stripping `On` and lowercasing:
  `OnKeyDown` -> `keydown`, matching `Event.KeyDown`.
- Protected names normalize punctuation, so `AriaLabel` and `aria-label` agree.
- Canonical emit order: one `Class`, one `Style`, preserved base attributes,
  Mixin-added attributes, one composed `OnMount`. Determinism comes from input
  order, not object traversal.
- `ChildAttribute` detection is the `__childAttribute` brand key (Foldkit's
  guard is private). Its inner `_tag` is read for ownership only; the value is
  never rebuilt.
- A composite Mount is named `Mixins[<slot>](A,B)`; two Mounts sharing one name
  is a `mixins:duplicate-mount-name` error.
- Conflicts throw `DiagnosticError` with a stable `code`; see `diagnostics.ts`.

### Behavior and the Mixin algebra

- A `Mixin` contribution is static data (`StaticMixin`) or deferred (`Mixin`).
  `MixinFor<Message>` is the union any view accepts: `Mixin<Message> |
  StaticMixin<Message> | Mixin<never>`.
- `Mixin<never>` must be named explicitly in that union: a message-free dynamic
  Mixin does **not** widen to `Mixin<Message>`, because `HtmlBuilder` is
  invariant in `Message` and the deferred context carries `h`. `Style` produces
  a `Mixin<never>` so it attaches to any view.
- A deferred contribution is `(context: { input; h }) => StaticContribution`.
  Input-driven Style compiles to the narrower `InputContribution`,
  `(context: { input }) => StaticContribution`, which names no Message universe
  and so is assignable to the dynamic form for every `Message`. The context's
  `input` is `unknown` at the container level; authors and Behavior re-narrow it.
- `buildersFor` evaluates deferred contributions lazily inside `attrs`, per
  render, so a Behavior sees the view's `input` and `h` and an input-driven
  Style is folded against the same `input`.
- Behavior validates its `requires` against the target Slot at definition time
  (`mixins:unknown-slot`, `mixins:capability-mismatch`,
  `mixins:unsupported-event`, `mixins:unsupported-attribute`).
- Behavior owns no state. Stateful widgets stay `@foldkit/ui` Submodels; a
  continuous element listener is a Mount; a network call is Message -> update ->
  Command.
- Mount composition is runtime-tested. A composed `f` merges every inner stream
  with `Stream.mergeAll` (unbounded); a failing inner stream fails the merge
  rather than being swallowed; and `foldkit/test`'s `Scene` observes two
  Behaviors' mounts as exactly one Mount named `Mixins[<slot>](A,B)`. Element
  lifetime, finalizer ordering, time travel and re-render identity stay
  Foldkit's, not this package's.

### Input-driven Style

- `Style.whenInput(predicate, piece)` defers a piece to render time; it applies
  when `predicate` sees the view's `input`. `Style.when` remains the
  authoring-time boolean.
- `Style.compose` concatenates conditions, and `resolveStyle` folds active
  conditions recursively, so a conditional piece may itself be conditional.
- A style with no conditions stays static data; one with conditions compiles to
  an `InputContribution`, still message-free.

### A11y patterns

- An `A11y.pattern` is a portable requirements map: slot name -> required
  capability, events, attributes, and `optional`. It is independent of any one
  component, so `validate` is a runtime check, not a compile-time one. A pattern
  naming a slot a contract lacks is a reportable diagnostic, not an unreadable
  `never`.
- `A11y.validate(pattern, slots)` returns every mismatch as an `A11yDiagnostic`
  with a stable `a11y:*` code, in authored order. It is pure and DOM-independent:
  it checks the declared contract, never a rendered tree, and claims no WCAG
  certification.
- A missing non-optional slot, a hidden slot, a capability the slot does not
  satisfy, and unpublished events or attributes are each reported. A hidden slot
  is reported once and not checked further. An `optional` slot may be absent but
  is still checked when present.
- Slot lookup uses `Object.hasOwn`, so a plain-object contract cannot answer for
  an inherited key such as `toString`.
- `Diagnostic.source` widened to `'mixins' | 'a11y'`, so both layers share one
  data shape and tooling consumes them uniformly.

### `@foldkit/ui` adapter (`foldkit-mixins-ui`)

- A separate package: `foldkit-mixins-ui` peers on `@foldkit/ui`, `effect`,
  `foldkit`, and `foldkit-mixins`, so core stays free of `@foldkit/ui`.
- `@foldkit/ui` components do not own markup: they build typed attribute bundles
  and hand them to a consumer `toView`. The adapter formalizes those bundles as
  `Slots` and `resolve` merges attached Mixins per bundle. Base attributes, event
  Messages and `ChildAttribute`s are preserved by identity; non-slot entries
  (`Disclosure.animatePanel`) pass through unchanged.
- Published contracts: Button (`button`), Input (`input`/`label`/`description`),
  Textarea (`textarea`/`label`/`description`), Checkbox
  (`checkbox`/`label`/`description`/`hiddenInput`), Switch, Fieldset
  (`fieldset`/`legend`/`description`), Disclosure (`button`/`panel`), and
  Dialog (`dialog`/`backdrop`/`panel`/`title`/`description`/`initialFocus`/
  `closeButton`). A slot advertises the capability, events and attributes a
  Behavior may require; the base bundle's ownership is what turns taking over a
  click into a `mixins:event-conflict` rather than a second silent handler.
- Dialog is a Submodel: its bundles are `ChildAttribute` groups carrying the
  dialog boundary's dispatcher. `Dialog.resolve` preserves them by identity and
  passes `isVisible` through. It is tested with `foldkit/test`'s `Scene`, which
  supplies a runtime frame and the real `h` without a DOM, so the resolver is
  exercised against real ChildAttributes — including the close button's owned
  `click`.
- The remaining Submodels (Menu, Tabs, ComboBox, ...) and the Surface adapter
  remain.

## Phase plan (this package)

0. Probes — this file. Done.
1. Capability, Event, Attr, Slot, Slots. Metadata only. Done.
2. Mixin contribution model + deterministic resolver. Done.
3. SlotView. Done.
4. Style v1 (class, inline, compose, when, whenInput). Done.
5. Theme + recipes. Done.
6. Behavior v1 (no hidden state). Done.
7. Mount composition. Done.
8. A11y patterns + diagnostics. Done.
9. `@foldkit/ui` adapter (separate package). Stateless set + Dialog (Submodel)
   done; further Submodel components remain.
10. Surface adapter (separate package).

Style CSS compiler, DevTools, and agent metadata wait until the core
survives real views.

## Non-goals

No atoms, hooks, component-local state, query cache, mutable element
handles as the default path, hidden event buses, or a second update loop.
A Behavior that needs state uses a Foldkit Model/Submodel. A network call
is Message → update → Command. Element-owned lifecycle is a Mount.
