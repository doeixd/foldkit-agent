import type { DisclosureAttributes } from '@foldkit/ui/disclosure'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

export const DisclosureSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.AriaExpanded, Attr.AriaDisabled, Attr.Disabled],
  }),
  panel: Slot.make({ capability: Capability.Container }),
})

/** `animatePanel` is not an attribute bundle, so it passes through unchanged. */
export const resolve = <Input, Message>(
  attributes: DisclosureAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(DisclosureSlots, mixins, context)(attributes)
