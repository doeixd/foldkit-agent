import type { RenderInfo } from '@foldkit/ui/dialog'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * Dialog is a Submodel: each published bundle is a `ChildAttribute` group that
 * carries the dialog boundary's dispatcher. The resolver treats those as opaque
 * and preserves their identity, so spreading a resolved bundle into the parent's
 * markup keeps routing through the dialog's `toParentMessage`.
 *
 * `dialog` owns `cancel` (the native Escape handler); `backdrop` and
 * `closeButton` own `click`. A Behavior adding its own handler to one of those
 * is a conflict, not a second silent owner.
 */
export const DialogSlots = Slots.define({
  dialog: Slot.make({
    capability: Capability.Container,
    events: [Event.Cancel],
    attributes: [Attr.AriaDescribedby],
  }),
  backdrop: Slot.make({ capability: Capability.Container, events: [Event.Click] }),
  panel: Slot.make({ capability: Capability.Container }),
  title: Slot.make({ capability: Capability.Container }),
  description: Slot.make({ capability: Capability.Container }),
  initialFocus: Slot.make({ capability: Capability.Focusable }),
  closeButton: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.Disabled],
  }),
})

/** Resolves the dialog's render groups; `isVisible` passes through unchanged. */
export const resolve = <Input, Message>(
  render: RenderInfo,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(DialogSlots, mixins, context)(render)
