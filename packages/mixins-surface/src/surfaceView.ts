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
import { SlotView, type SlotViewRender } from 'foldkit-mixins'

export const define = <Root, Model, Message, Params, Slots>(
  surface: Surface<Root, Model, Message, Params>,
  slots: Slots,
  render: SlotViewRender<Slots, Model, Message>,
  options?: { readonly name?: string },
): SlotView.SlotView<Slots, Model, Message> =>
  SlotView.define<Slots, Model, Message>(slots, render, {
    name: options?.name ?? surface.name,
  })

/**
 * Adapts a SlotView to a Surface renderer. `Surface.view` hands a renderer a
 * `ViewBuilder` — the real builder with its `MessageUniverse` phantom removed —
 * and this is the matching boundary cast, sound because the renderer only
 * constructs the Surface's Message subset.
 */
export const toRenderer =
  <Slots, Model, Message>(
    view: SlotView.SlotView<Slots, Model, Message>,
  ): Renderer<Model, Message> =>
  (model, h) =>
    view(model, h as unknown as HtmlBuilder<Message>)
