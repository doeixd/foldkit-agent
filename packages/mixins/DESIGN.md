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

## Merge policy (resolver, later phase)

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

## Phase plan (this package)

0. Probes — this file. Done.
1. Capability, Event, Attr, Slot, Slots. Metadata only.
2. Mixin contribution model + deterministic resolver.
3. SlotView.
4. Style v1 (class, inline, compose, when, whenInput).
5. Theme + recipes.
6. Behavior v1 (no hidden state).
7. Mount composition.
8. A11y patterns + diagnostics.
9. `@foldkit/ui` adapter (separate package).
10. Surface adapter (separate package).

Style CSS compiler, DevTools, and agent metadata wait until the core
survives real views.

## Non-goals

No atoms, hooks, component-local state, query cache, mutable element
handles as the default path, hidden event buses, or a second update loop.
A Behavior that needs state uses a Foldkit Model/Submodel. A network call
is Message → update → Command. Element-owned lifecycle is a Mount.
