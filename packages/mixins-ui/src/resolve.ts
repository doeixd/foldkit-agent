/**
 * Binds a `@foldkit/ui` component's published Slots and the Mixins attached to
 * it. The returned function takes the component's own attribute bundles (from
 * its `toView` callback) and returns them with Mixin contributions resolved by
 * the core resolver. Base attributes and `ChildAttribute`s are preserved
 * untouched; non-slot entries (`animatePanel`) pass through unchanged.
 */
import type { HtmlBuilder } from 'foldkit/html'
import { SlotView, type MixinValue, type SlotAttributes, type StaticMixin } from 'foldkit-mixins'

export type MixinList<Message> = ReadonlyArray<
  MixinValue<Message> | MixinValue<never> | StaticMixin<Message>
>

export interface ResolveContext<Input, Message> {
  readonly input: Input
  readonly h: HtmlBuilder<Message>
}

export type ResolvedSlots<Slots, Message> = {
  readonly [K in keyof Slots]: SlotAttributes<Message>
}

export const resolveFor =
  <Slots, Input, Message>(
    slots: Slots,
    mixins: MixinList<Message>,
    context: ResolveContext<Input, Message>,
  ) =>
  <Base extends { readonly [K in keyof Slots]?: SlotAttributes<Message> }>(
    base: Base,
  ): Omit<Base, keyof Slots> & ResolvedSlots<Slots, Message> => {
    const builders = SlotView.buildersFor(slots, mixins, context)
    const out: Record<string, unknown> = Object.assign(Object.create(null), base)
    for (const name of Object.getOwnPropertyNames(slots as object)) {
      out[name] = builders[name as keyof Slots].attrs(base[name as keyof Slots])
    }
    return out as Omit<Base, keyof Slots> & ResolvedSlots<Slots, Message>
  }
