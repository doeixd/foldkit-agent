/**
 * `SlotView` is the structural equivalent of a Surface: a pure Foldkit view
 * that publishes typed Slots and lets Mixins attach without forking it. It
 * owns no state and runs no Effects; the attached Mixins are resolved into
 * ordinary Foldkit attributes per slot.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { Mixin } from './mixin.js'
import { pipeSelf, type Pipeable } from './pipe.js'
import { resolveSlot, type SlotAttributes } from './resolver.js'
import type { Any as AnySlot, SlotProtection } from './slot.js'

export type SlotBuilder<Message> = {
  readonly attrs: (base?: SlotAttributes<Message>) => SlotAttributes<Message>
}

export type SlotBuilders<Slots, Message> = {
  readonly [K in keyof Slots]: SlotBuilder<Message>
}

export type SlotViewRender<Slots, Input, Message> = (
  input: Input,
  slots: SlotBuilders<Slots, Message>,
  h: HtmlBuilder<Message>,
) => Html

export interface SlotView<Slots, Input, Message> extends Pipeable<SlotView<Slots, Input, Message>> {
  (input: Input, h: HtmlBuilder<Message>): Html
  readonly name?: string
  readonly slots: Slots
  readonly mixins: ReadonlyArray<Mixin<Message>>
  readonly render: SlotViewRender<Slots, Input, Message>
}

/** Build one `attrs` resolver per published slot, folding the view's Mixins. */
export const buildersFor = <Slots, Message>(
  slots: Slots,
  mixins: ReadonlyArray<Mixin<Message>>,
): SlotBuilders<Slots, Message> => {
  const source = slots as unknown as Record<string, AnySlot>
  const builders: Record<string, SlotBuilder<Message>> = {}
  for (const name of Object.getOwnPropertyNames(source)) {
    const slot = source[name]
    if (slot === undefined) continue
    const protection: SlotProtection = slot.protected
    builders[name] = {
      attrs: (base?: SlotAttributes<Message>) =>
        resolveSlot(base, mixins, name, { protected: protection }),
    }
  }
  return builders as SlotBuilders<Slots, Message>
}

const makeView = <Slots, Input, Message>(
  name: string | undefined,
  slots: Slots,
  mixins: ReadonlyArray<Mixin<Message>>,
  render: SlotViewRender<Slots, Input, Message>,
): SlotView<Slots, Input, Message> => {
  const builders = buildersFor(slots, mixins)
  const view = (input: Input, h: HtmlBuilder<Message>): Html => render(input, builders, h)
  // A function's own `name` is read-only; define it rather than assigning.
  if (name !== undefined) {
    Object.defineProperty(view, 'name', { value: name, configurable: true })
  }
  return Object.assign(view, {
    slots,
    mixins,
    render,
    pipe: (...fns: ReadonlyArray<(self: unknown) => unknown>) => pipeSelf(view, fns),
  }) as unknown as SlotView<Slots, Input, Message>
}

export const define = <Slots, Input, Message>(
  slots: Slots,
  render: SlotViewRender<Slots, Input, Message>,
  options?: { readonly name?: string },
): SlotView<Slots, Input, Message> => makeView(options?.name, slots, [], render)

/** Attach one Mixin. Returns a new view; the original is unchanged. */
export const attach =
  <Slots, Input, Message>(mixin: Mixin<Message>) =>
  (view: SlotView<Slots, Input, Message>): SlotView<Slots, Input, Message> =>
    makeView(view.name, view.slots, [...view.mixins, mixin], view.render)
