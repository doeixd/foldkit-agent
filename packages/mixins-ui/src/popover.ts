import type { RenderInfo } from '@foldkit/ui/popover'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * Popover is a Submodel; every bundle is a `ChildAttribute` group. `button`
 * owns `click` (and its pointer/keyboard handlers) while open; `panel` owns
 * `blur`; `backdrop` owns `click`. The panel and backdrop bundles also carry
 * the anchor and portal Mounts, preserved as opaque `ChildAttribute`s.
 */
export const PopoverSlots = Slots.define({
  button: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.AriaExpanded, Attr.AriaDisabled, Attr.Disabled],
  }),
  panel: Slot.make({ capability: Capability.Container, events: [Event.Blur] }),
  backdrop: Slot.make({ capability: Capability.Container, events: [Event.Click] }),
  arrow: Slot.make({ capability: Capability.Container }),
})

/** Resolves the popover's render groups; `isVisible` passes through unchanged. */
export const resolve = <Input, Message>(
  render: RenderInfo,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(PopoverSlots, mixins, context)(render)
