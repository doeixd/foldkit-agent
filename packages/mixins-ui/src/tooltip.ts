import type { RenderInfo } from '@foldkit/ui/tooltip'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * Tooltip is a Submodel; both bundles are `ChildAttribute` groups. `trigger`
 * owns `focus`, `blur` and `pointerdown` (the hover/keyboard entry points);
 * `panel` carries the anchor Mount. `resolve` preserves each group by identity.
 */
export const TooltipSlots = Slots.define({
  trigger: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Focus, Event.Blur, Event.PointerDown],
    attributes: [Attr.Role, Attr.AriaDisabled, Attr.Disabled],
  }),
  panel: Slot.make({ capability: Capability.Container, attributes: [Attr.Role] }),
})

/** Resolves the tooltip's render groups; `isVisible` passes through unchanged. */
export const resolve = <Input, Message>(
  render: RenderInfo,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(TooltipSlots, mixins, context)(render)
