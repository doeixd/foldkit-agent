import type { SelectAttributes } from '@foldkit/ui/select'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * The base bundle installs `OnChange` only when `onChange` is configured and
 * the control is enabled, so a Behavior that adds its own handler is a
 * conflict rather than a second silent owner.
 */
export const SelectSlots = Slots.define({
  select: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Change],
    attributes: [Attr.AriaLabel, Attr.AriaInvalid, Attr.Disabled, Attr.Value],
  }),
  label: Slot.make({ capability: Capability.Container }),
  description: Slot.make({ capability: Capability.Container }),
})

export const resolve = <Input, Message>(
  attributes: SelectAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(SelectSlots, mixins, context)(attributes)
