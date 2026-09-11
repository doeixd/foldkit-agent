import type { SwitchAttributes } from '@foldkit/ui/switch'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/** Mirrors the checkbox contract: both the control and its label own `click`. */
export const SwitchSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.AriaDisabled, Attr.Disabled, Attr.Value],
  }),
  label: Slot.make({
    capability: Capability.Container,
    events: [Event.Click],
  }),
  description: Slot.make({ capability: Capability.Container }),
  hiddenInput: Slot.make({
    capability: Capability.Base,
    attributes: [Attr.Value],
  }),
})

export const resolve = <Input, Message>(
  attributes: SwitchAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(SwitchSlots, mixins, context)(attributes)
