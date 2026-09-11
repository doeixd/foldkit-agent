import type { FieldsetAttributes } from '@foldkit/ui/fieldset'
import { Attr, Capability, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

export const FieldsetSlots = Slots.define({
  fieldset: Slot.make({
    capability: Capability.Container,
    attributes: [Attr.Disabled],
  }),
  legend: Slot.make({ capability: Capability.Container }),
  description: Slot.make({ capability: Capability.Container }),
})

export const resolve = <Input, Message>(
  attributes: FieldsetAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(FieldsetSlots, mixins, context)(attributes)
