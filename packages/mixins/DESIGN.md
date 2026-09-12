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
  (`mixins:unknown-slot`, `mixins:hidden-slot`, `mixins:capability-mismatch`,
  `mixins:unsupported-event`, `mixins:unsupported-attribute`).
- A `hidden` slot is internal: `Style.forSlots` and `Behavior.forSlots` exclude
  it from their spec types and reject it at runtime (`mixins:hidden-slot`), so
  the only way to reach one is an explicit cast.
- Behavior owns no state. Stateful widgets stay `@foldkit/ui` Submodels; a
  continuous element listener is a Mount; a network call is Message -> update ->
  Command.
- `Mixin.mapInput` / `forSlot` / `describe` are deliberately absent. A `Mixin`
  is not parameterized by its input: `context.input` is `unknown` and re-narrowed
  by the authoring helper, so `mapInput` has no honest type here; nothing needs
  `forSlot`; and `SurfaceView.inspect` covers view-level introspection. Add them
  with a concrete caller rather than speculatively.
- Event ownership normalizes a tag by stripping `On` and lowercasing, so
  `OnKeyDownPreventDefault` owns `keydownpreventdefault`, not `keydown`. A slot
  whose base installs a prevent-default handler therefore does not advertise
  `Event.KeyDown`, and a Behavior adding `OnKeyDown` beside it would not be
  flagged. No adapter currently declares `Event.KeyDown`, so this is latent;
  unifying the two would need a suffix-aware normalization in the resolver.
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
  Textarea (`textarea`/`label`/`description`), Select (`select`/`label`/
  `description`), Checkbox (`checkbox`/`label`/`description`/`hiddenInput`),
  Switch, Fieldset (`fieldset`/`legend`/`description`), Disclosure
  (`button`/`panel`), Dialog (`dialog`/`backdrop`/`panel`/`title`/`description`/
  `initialFocus`/`closeButton`), Popover (`button`/`panel`/`backdrop`/`arrow`),
  Tooltip (`trigger`/`panel`), Slider (`root`/`track`/`filledTrack`/`thumb`/
  `label`/`hiddenInput`), Tabs (`tablist`/`tab`/`panel`), RadioGroup
  (`group`/`option`/`label`/`description`/`hiddenInput`), and Calendar (top-level
  groups plus the nested `columnHeader`/`weekRow`/`dayCell`/`dayButton`/
  `monthCell`/`monthButton`/`yearCell`/`yearButton`). A slot advertises the
  capability, events and attributes a Behavior may require; the base bundle's
  ownership is what turns taking over a click into a `mixins:event-conflict`
  rather than a second silent handler.
- Dialog, Popover, Tooltip, Slider, Tabs, RadioGroup and Calendar are Submodels:
  their bundles are `ChildAttribute` groups carrying the child boundary's
  dispatcher and, for Popover/Tooltip, its anchor/portal Mounts. `resolve`
  preserves them by identity and passes `isVisible`/`activeIndex`/`selectedValue`
  through. All are tested with `foldkit/test`'s `Scene`, which supplies a runtime
  frame and the real `h` without a DOM, so the resolver is exercised against real
  ChildAttributes — including the owned close/trigger `click`, `focus` or
  `pointerdown`.
- **Not every component is adaptable.** `Menu`, `Listbox`, `ComboBox` and
  `DatePicker` own their markup outright: their views build the whole element
  tree internally, expose no `toView`/`RenderInfo`, and never hand the consumer
  attribute bundles, so there is no seam for `resolve` to attach to.
- **Nested bundles use `SlotView.buildersFor` directly.** `Tabs`, `RadioGroup`
  and `Calendar` publish per-item groups (`tabs[i].tab`, `options[i].option`,
  `weeks[].cells[].cellAttributes`). `resolveFor` only handles a flat record, so
  a nested adapter calls `SlotView.buildersFor(slots, mixins, context)` itself:
  the container slots resolve with `builders[name].attrs(base)`, and each item is
  mapped with the same builders. One slot contribution therefore applies to
  every item, while each item's base still owns its own events (a disabled tab
  omits `OnClick`, so a Behavior may add one only there).
### Surface bridge (`foldkit-mixins-surface`)

- `SurfaceView.define(surface, slots, render)` type-binds a Surface's projected
  Model and Message subset to a core `SlotView`. Input is the projection, so a
  Style/Behavior callback cannot read the root Model; the builder is
  `HtmlBuilder<subset>`, so a Behavior cannot emit a Message the Surface does not
  expose.
- The result is an ordinary `SlotView`, so the core attach/pipe algebra applies
  unchanged. `SurfaceView.toRenderer` is the one boundary cast: `Surface.view`
  hands a renderer a `ViewBuilder` (the builder minus its `MessageUniverse`
  phantom), which core's `HtmlBuilder` parameter cannot accept nominally.
- A core change that would erase the cast — accepting `Omit<HtmlBuilder, symbol>`
  throughout — was prototyped and rejected: it forces every render/Behavior
  annotation to switch types under contravariance, for little gain.
- Started, not complete: runtime composition through `Surface.rootView` in a real
  application is covered by tests, and `SurfaceView.inspect(view)` returns
  serializable `{ name, slots, mixins }` (no functions), composing with
  `Surface.inspect`'s observation/emit metadata. `describe(surface, params, view)`
  merges both into one serializable description and `toMarkdown` renders it
  deterministically for docs/CI. A stateless `@foldkit/ui`
  component composes inside a SurfaceView — the Surface's Message subset flows
  into the component config and a Mixin resolves around its bundle, proven with a
  test-only edge to `foldkit-mixins-ui`. `examples/mixins` is a worked
  Surface + Mixins trace (asserted line by line). A remote-backed example
  (Phase 11) remains.

### Advanced Style compiler (Phase 12)

Status: started. v1 compiles rule-based Style to a deterministic class plus CSS
text; collection stays caller-owned.

- A `StyleRule` is `{ selector, at?, declarations }`. `selector` is relative to
  the generated class and uses `&` (`&:hover`, `&[data-open]`). Declarations are
  authored in camelCase and emitted kebab-cased.
- `Style.pseudo`/`media`/`supports`/`container`/`nest` produce a StyleValue
  carrying rules; `Style.compose` concatenates them.
- `Style.keyframes(frames)` returns `{ name, style }` with a deterministic
  `kf-<hash>` name and a global `@keyframes` block; `Style.global(css)` is the
  raw escape hatch for layers and other global rules. Both ride a separate
  `globalCss` channel (`NamedStyle.globalCss`), because they are not scoped to a
  generated class.
- Compilation is deterministic: declarations are sorted, rules/steps keep
  authored order, and the class/keyframes name is an FNV-1a base36 hash of the
  canonical text. Equal rules share a class; different rules differ.
- **No render-time collection and no import-time DOM mutation.** The CSS text is
  data (`NamedStyle.css`/`globalCss`), so SSR and the browser derive the same
  class and rules, and the application decides where to inject it. `NamedStyle`
  also carries structured `rules`/`globalRules`, so `Style.stylesheet([...styles])`
  deduplicates by generated class and by global chunk at build/list time, not
  from inside a render. A test compiles a style twice and asserts the class, CSS
  and stylesheet are identical, standing in for server/client equality.
- Rules under `Style.whenInput` are **rejected** in v1, because the class is
  static while the condition is not. The diagnostic is
  `style:conditional-rules-unsupported`. Keyframes/global CSS under a condition
  are allowed: the CSS is emitted either way and only the reference is
  conditional.
- Not in v1: render-time collection/extraction, `@font-face` sugar, and
  animation-orchestration helpers. Style stays in `foldkit-mixins` for now;
  extract `foldkit-style` only if the compiler grows a real AST.

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
9. `@foldkit/ui` adapter (separate package). Stateless set plus Submodels
   Dialog/Popover/Tooltip/Slider/Tabs/RadioGroup/Calendar done.
   Menu/Listbox/ComboBox/DatePicker expose no consumer seam.
10. Surface adapter (separate package). `foldkit-mixins-surface` bridges a
    Surface's projected Model and Message subset to a SlotView. Started, not
    complete.
11. Remote-backed example. Done: `examples/remote` traces plan → prefetch →
    render → mutate → decode failure.
12. Advanced Style compiler. Started: pseudo/media, deterministic class + CSS.
13. DevTools/agent metadata. Started: `SurfaceView.describe`/`toMarkdown`.

The compiler's remaining constructs (`@font-face` sugar, animation
orchestration, a rule registry with extraction) wait until a real view needs
them.

## Non-goals

No atoms, hooks, component-local state, query cache, mutable element
handles as the default path, hidden event buses, or a second update loop.
A Behavior that needs state uses a Foldkit Model/Submodel. A network call
is Message → update → Command. Element-owned lifecycle is a Mount.
