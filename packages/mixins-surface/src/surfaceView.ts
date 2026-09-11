/**
 * Binds a Surface's projected Model and Message subset to a SlotView.
 *
 * The renderer's input is the Surface's projected Model, so Style and Behavior
 * contributions can only read what the Surface projects. Its builder is typed
 * with the Surface's Message subset, so a Behavior cannot emit a Message the
 * Surface does not expose. The returned value is an ordinary `SlotView`, so the
 * core attach/pipe algebra applies unchanged.
 */
import type { HtmlBuilder } from 'foldkit/html'
import type { Renderer, Surface } from 'foldkit-surface'
import { Slots, SlotView, type SlotViewRender } from 'foldkit-mixins'

export const define = <Root, Model, Message, Params, Slots_>(
  surface: Surface<Root, Model, Message, Params>,
  slots: Slots_,
  render: SlotViewRender<Slots_, Model, Message>,
  options?: { readonly name?: string },
): SlotView.SlotView<Slots_, Model, Message> =>
  SlotView.define<Slots_, Model, Message>(slots, render, {
    name: options?.name ?? surface.name,
  })

/**
 * Adapts a SlotView to a Surface renderer. `Surface.view` hands a renderer a
 * `ViewBuilder` — the real builder with its `MessageUniverse` phantom removed —
 * and this is the matching boundary cast, sound because the renderer only
 * constructs the Surface's Message subset.
 */
export const toRenderer =
  <Slots_, Model, Message>(
    view: SlotView.SlotView<Slots_, Model, Message>,
  ): Renderer<Model, Message> =>
  (model, h) =>
    view(model, h as unknown as HtmlBuilder<Message>)

export interface SurfaceViewInspection {
  /** The SlotView's name, defaulted from the Surface's name. */
  readonly name: string
  readonly slots: ReturnType<typeof Slots.describe>['slots']
  readonly mixins: ReadonlyArray<string>
}

/**
 * Serializable metadata for DevTools and docs: the published slots and the
 * names of the attached Mixins, with no functions. It composes with
 * `Surface.inspect`, which reports what the Surface observes and emits.
 */
export const inspect = <Slots_, Model, Message>(
  view: SlotView.SlotView<Slots_, Model, Message>,
): SurfaceViewInspection => ({
  name: view.name ?? '',
  slots: Slots.describe(view.slots as unknown as Parameters<typeof Slots.describe>[0]).slots,
  mixins: view.mixins.map(mixin => mixin.name),
})
