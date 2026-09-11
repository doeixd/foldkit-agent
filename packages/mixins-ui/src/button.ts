import type { ButtonAttributes } from '@foldkit/ui/button'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * The button publishes one slot. `click` is owned by the base `OnClick` when
 * the button is interactive, so a Behavior that adds its own click handler is a
 * conflict rather than a second silent owner.
 */
export const ButtonSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.AriaDisabled, Attr.Disabled],
  }),
})

export const resolve = <Input, Message>(
  attributes: ButtonAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(ButtonSlots, mixins, context)(attributes)
