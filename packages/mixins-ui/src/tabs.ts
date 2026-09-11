import type { RenderInfo, TabInfo } from '@foldkit/ui/tabs'
import { Attr, Capability, Event, Slot, Slots, SlotView, type SlotAttributes } from 'foldkit-mixins'
import type { MixinList, ResolveContext } from './resolve.js'

/**
 * Tabs is a nested Submodel: one `tablist` group plus a `tab`/`panel` pair per
 * item, so the resolver runs once per group and each base `ChildAttribute`
 * bundle passes through by identity.
 *
 * Enabled tabs own `click` through the base `OnClick`; a Behavior adding its
 * own click handler is a conflict rather than a second silent owner. Disabled
 * tabs publish no click, so the contract still lists it as allowed.
 */
export const TabsSlots = Slots.define({
  tablist: Slot.make({ capability: Capability.Container, attributes: [Attr.Role] }),
  tab: Slot.make({
    capability: Capability.Interactive,
    events: [Event.Click],
    attributes: [Attr.Role, Attr.AriaSelected, Attr.Disabled, Attr.AriaDisabled],
  }),
  panel: Slot.make({ capability: Capability.Container, attributes: [Attr.Role] }),
})

export type ResolvedTab<Value extends string, Message> = Omit<TabInfo<Value>, 'tab' | 'panel'> & {
  readonly tab: SlotAttributes<Message>
  readonly panel: SlotAttributes<Message>
}

export interface ResolvedTabs<Value extends string, Message> {
  readonly tablist: SlotAttributes<Message>
  readonly tabs: ReadonlyArray<ResolvedTab<Value, Message>>
  readonly activeIndex: number
}

/** Resolves the tabs' nested render groups, preserving `activeIndex`. */
export const resolve = <Value extends string, Input, Message>(
  render: RenderInfo<Value>,
  mixins: MixinList<Message>,
  context: ResolveContext<Input, Message>,
): ResolvedTabs<Value, Message> => {
  const builders = SlotView.buildersFor(TabsSlots, mixins, context)
  return {
    tablist: builders.tablist.attrs(render.tablist),
    tabs: render.tabs.map(item => ({
      ...item,
      tab: builders.tab.attrs(item.tab),
      panel: builders.panel.attrs(item.panel),
    })),
    activeIndex: render.activeIndex,
  }
}
