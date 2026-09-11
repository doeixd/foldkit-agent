import type { CheckboxAttributes } from '@foldkit/ui/checkbox'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * Both the control and its label carry the base toggle handlers, so both own
 * `click`. `hiddenInput` exists only when a form `name` is configured; its base
 * bundle is then empty.
 */
export const CheckboxSlots = Slots.define({
  checkbox: Slot.make({
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
  attributes: CheckboxAttributes<Message>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(CheckboxSlots, mixins, context)(attributes)
