# foldkit-mixins-surface

Bridges [`foldkit-surface`](../surface)'s projected Model and Message subset to
[`foldkit-mixins`](../mixins) SlotViews.

`SurfaceView.define(surface, slots, render)` returns an ordinary `SlotView`: the
renderer's input is the Surface's projected Model, so Style and Behavior
contributions can only read what the Surface projects, and its builder is typed
with the Surface's Message subset, so a Behavior cannot emit a Message the
Surface does not expose. `SurfaceView.toRenderer` adapts the result to the
`Renderer` that `Surface.view`/`Surface.rootView` expect.

```ts
const TodoCardView = SurfaceView.define(TodoSurface, TodoSlots, (model, slots, h) =>
  h.li(slots.root.attrs(), [model.title]),
).pipe(Style.attach(TodoCardStyle), Behavior.attach(TodoCardBehavior))

Surface.view(TodoSurface, SurfaceView.toRenderer(TodoCardView))
```

## What the bridge enforces

- The renderer's input is the Surface's projected Model, so a Style/Behavior
  callback cannot read the root Model.
- The builder is typed with the Surface's Message subset, so a Behavior cannot
  emit a Message the Surface does not expose.
- The result is an ordinary core `SlotView`, so the core attach/pipe algebra
  applies unchanged. `toRenderer` is the single boundary cast, the same one
  `Surface.rootView` makes.

## Introspection

`SurfaceView.inspect(view)` returns serializable `{ name, slots, mixins }` with no
functions. `SurfaceView.describe(surface, params, view)` merges that with
`Surface.inspect` — what the Surface observes, requires, and may emit, with
emitted Messages as tags — into one value, and `SurfaceView.toMarkdown` renders it
deterministically for docs or a CI drift check.

Private while the API is settling (`0.0.0`). See [DESIGN.md](../mixins/DESIGN.md).
