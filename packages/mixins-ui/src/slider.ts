import type { SliderAttributes } from '@foldkit/ui/slider'
import { Attr, Capability, Event, Slot, Slots } from 'foldkit-mixins'
import { resolveFor, type MixinList, type ResolveContext } from './resolve.js'

/**
 * Slider is a Submodel: each published bundle is a `ChildAttribute` group that
 * carries the boundary's dispatcher. The resolver treats those as opaque and
 * preserves their identity, so spreading a resolved bundle into the parent's
 * markup keeps routing through the slider's `toParentMessage`.
 *
 * The base installs the pointer handler on `track` and `thumb` only while the
 * slider is interactive. A Behavior adding one of those owns it in the same
 * window, so a second owner is a conflict rather than a silent takeover. Its
 * keyboard handler is `OnKeyDownPreventDefault`, a distinct tag from `KeyDown`,
 * so the thumb does not advertise `Event.KeyDown` (it would falsely imply a
 * conflict the resolver cannot see).
 */
export const SliderSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container }),
  track: Slot.make({
    capability: Capability.Container,
    events: [Event.PointerDown],
  }),
  filledTrack: Slot.make({ capability: Capability.Base }),
  thumb: Slot.make({
    capability: Capability.Focusable,
    events: [Event.PointerDown],
    attributes: [Attr.Role],
  }),
  label: Slot.make({ capability: Capability.Container }),
  hiddenInput: Slot.make({
    capability: Capability.Base,
    attributes: [Attr.Value],
  }),
})

/** Resolves the slider's render groups; `value` and the rest pass through unchanged. */
export const resolve = <Input, Message>(
  render: SliderAttributes,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
) => resolveFor(SliderSlots, mixins, context)(render)
