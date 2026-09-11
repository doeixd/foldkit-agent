import { describe, expect, it } from 'vitest'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as TabsUi from '@foldkit/ui/tabs'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Tabs, TabsSlots, type ResolvedTabs } from '../src/index.js'

type DemoValue = 'overview' | 'settings'

const DemoTabs = TabsUi.create<DemoValue>()

type TabsMixins = ReadonlyArray<MixinValue<TabsUi.Message> | MixinValue<never>>

interface Captured {
  readonly render: TabsUi.RenderInfo<DemoValue>
  readonly resolved: ResolvedTabs<DemoValue, TabsUi.Message>
}

/**
 * `DemoTabs.view` publishes its groups through `childAttributes`, which throws
 * outside a runtime frame. `Scene.scene` supplies that frame and the real `h`,
 * so `toView` receives real ChildAttributes rather than a synthetic brand.
 */
const runTabs = (mixins: TabsMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: DemoTabs.update,
      view: (model, h) =>
        DemoTabs.view(
          model,
          {
            tabs: ['overview', 'settings'] as const,
            selectedValue: 'overview',
            ariaLabel: 'Sections',
            toView: render => {
              const resolved = Tabs.resolve(render, mixins, { input: undefined, h })
              capture({ render, resolved })
              return h.div(
                [...resolved.tablist],
                resolved.tabs.map(item => h.button([...item.tab], [])),
              )
            },
          },
          h,
        ),
    },
    Scene.given(TabsUi.init({ id: 'test-tabs' })),
  )
}

const holds = (
  attributes: SlotAttributes<TabsUi.Message>,
  child: SlotAttributes<TabsUi.Message>[number],
): boolean => attributes.includes(child)

/** Every base child survives resolution in the resolved bundle. */
const preserves = (
  base: ReadonlyArray<SlotAttributes<TabsUi.Message>[number]>,
  resolved: SlotAttributes<TabsUi.Message>,
): void => {
  for (const child of base) expect(holds(resolved, child)).toBe(true)
}

const classValue = (attributes: SlotAttributes<TabsUi.Message>): string | undefined => {
  for (const attribute of attributes) {
    if (
      typeof attribute === 'object' &&
      attribute !== null &&
      '_tag' in attribute &&
      (attribute as { readonly _tag: string })._tag === 'Class'
    ) {
      return (attribute as { readonly value: string }).value
    }
  }
  return undefined
}

const diagnosticFrom = (run: () => void): Diagnostics.Diagnostic | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    if (error instanceof Diagnostics.DiagnosticError) return error.diagnostic
    throw error
  }
}

describe('Tabs adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runTabs([], value => {
      captured = value
    })
    const view = captured!
    expect(view.resolved.activeIndex).toBe(0)
    expect(Object.hasOwn(view.render.tablist[0] as object, '__childAttribute')).toBe(true)
    preserves(view.render.tablist, view.resolved.tablist)
    expect(view.resolved.tabs).toHaveLength(view.render.tabs.length)
    for (let index = 0; index < view.render.tabs.length; index++) {
      const base = view.render.tabs[index]!
      const resolved = view.resolved.tabs[index]!
      expect(Object.hasOwn(base.tab[0] as object, '__childAttribute')).toBe(true)
      expect(Object.hasOwn(base.panel[0] as object, '__childAttribute')).toBe(true)
      preserves(base.tab, resolved.tab)
      preserves(base.panel, resolved.panel)
    }
  })

  it('styles the tab slot without rebuilding its ChildAttributes', () => {
    const TabStyle = Style.forSlots(TabsSlots)({ tab: Style.class('tabs-tab') })
    let captured: Captured | undefined
    runTabs([TabStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    for (let index = 0; index < view.render.tabs.length; index++) {
      preserves(view.render.tabs[index]!.tab, view.resolved.tabs[index]!.tab)
      expect(classValue(view.resolved.tabs[index]!.tab)).toBe('tabs-tab')
    }
  })

  it('refuses a Behavior that takes over the enabled tab click', () => {
    const diagnostic = diagnosticFrom(() => {
      const Steal = Behavior.forSlots(TabsSlots)<undefined, TabsUi.Message>({
        tab: Behavior.slot({
          requires: { events: [Event.Click] },
          attributes: ({ h }: { readonly h: HtmlBuilder<TabsUi.Message> }) => [
            h.OnClick(TabsUi.Message.SelectedTab({ index: 0, value: 'overview' })),
          ],
        }),
      })
      runTabs([Steal.mixin], () => {})
    })
    expect(diagnostic?.code).toBe('mixins:event-conflict')
  })
})
