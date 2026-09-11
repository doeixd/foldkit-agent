/**
 * `SlotView` is the structural equivalent of a Surface: a pure Foldkit view
 * that publishes typed Slots and lets Mixins attach without forking it. It
 * owns no state and runs no Effects. Attached Mixins are resolved into
 * ordinary Foldkit attributes per slot, using the view's own `h` so Message
 * capability masking is preserved.
 */
import type { Html, HtmlBuilder } from 'foldkit/html'
import { evaluate, type AnyMixin, type Mixin, type StaticMixin } from './mixin.js'
import { pipeSelf, type Pipeable } from './pipe.js'
import { resolve, type SlotAttributes } from './resolver.js'
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
  readonly mixins: ReadonlyArray<Mixin<Message> | StaticMixin<Message>>
  readonly render: SlotViewRender<Slots, Input, Message>
}

/** Build one `attrs` resolver per published slot, evaluating Mixins lazily. */
export const buildersFor = <Slots, Message, Input>(
  slots: Slots,
  mixins: ReadonlyArray<Mixin<Message> | StaticMixin<Message>>,
  context: { readonly input: Input; readonly h: HtmlBuilder<Message> },
): SlotBuilders<Slots, Message> => {
  const source = slots as unknown as Record<string, AnySlot>
  const builders: Record<string, SlotBuilder<Message>> = Object.create(null)
  for (const name of Object.getOwnPropertyNames(source)) {
    const slot = source[name]
    if (slot === undefined) continue
    const protection: SlotProtection = slot.protected
    builders[name] = {
      attrs: (base?: SlotAttributes<Message>) => {
        const contributions = []
        for (const mixin of mixins) {
          const contribution = mixin.contributions[name]
          if (contribution !== undefined) {
            contributions.push(evaluate(contribution, { input: context.input, h: context.h }))
          }
        }
        return resolve(base, contributions, { slot: name, protected: protection })
      },
    }
  }
  return builders as SlotBuilders<Slots, Message>
}

const makeView = <Slots, Input, Message>(
  name: string | undefined,
  slots: Slots,
  mixins: ReadonlyArray<Mixin<Message> | StaticMixin<Message>>,
  render: SlotViewRender<Slots, Input, Message>,
): SlotView<Slots, Input, Message> => {
  const view = (input: Input, h: HtmlBuilder<Message>): Html =>
    render(input, buildersFor(slots, mixins, { input, h }), h)
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

/** A transform on any view, used by Message-free static mixins such as Style. */
export type SlotViewTransform = <Slots, Input, Message>(
  view: SlotView<Slots, Input, Message>,
) => SlotView<Slots, Input, Message>

/** A transform restricted to one Message universe, for Behavior mixins. */
export type SlotViewTransformFor<Message> = <Slots, Input>(
  view: SlotView<Slots, Input, Message>,
) => SlotView<Slots, Input, Message>

/** Attach one Mixin. Returns a new view; the original is unchanged. */
export function attach(mixin: StaticMixin<never>): SlotViewTransform
export function attach<MixinMessage>(mixin: Mixin<MixinMessage>): SlotViewTransformFor<MixinMessage>
export function attach(mixin: AnyMixin): any {
  return (view: SlotView<any, any, any>) =>
    makeView(view.name, view.slots, [...view.mixins, mixin], view.render)
}
