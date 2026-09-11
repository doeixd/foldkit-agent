import type { InputAttributes } from '@foldkit/ui/input'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

export const InputSlots = Slots.define({
  input: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Input, Event.Focus, Event.Blur],
    attributes: [Attr.AriaLabel, Attr.AriaInvalid, Attr.Disabled, Attr.Value],
  }),
  label: Slot.make({ capability: Capability.Container }),
  description: Slot.make({ capability: Capability.Container }),
})

export const resolve = <Input, Message>(
  attributes: InputAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(InputSlots, mixins, context)(attributes)
