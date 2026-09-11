import { Attr, Capability, Event, Slot, Slots } from '../src/index.js'

export const FieldSlots = Slots.define({
  root: Slot.make({
    capability: Capability.Container,
  }),
  label: { capability: Capability.Container },
  input: Slot.make({
    capability: Capability.TextInput,
    events: [Event.Input, Event.Focus, Event.Blur],
    attributes: [Attr.AriaLabel, Attr.AriaInvalid],
  }),
  internals: {
    capability: Capability.Base,
    hidden: true,
  },
})
