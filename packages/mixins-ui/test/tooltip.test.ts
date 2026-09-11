import { describe, expect, it } from 'vitest'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as Tooltip from '@foldkit/ui/tooltip'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Tooltip as TooltipAdapter, TooltipSlots } from '../src/index.js'
import { classValue, holds } from './fixture.js'

type TooltipMixins = ReadonlyArray<MixinValue<Tooltip.Message> | MixinValue<never>>

interface Captured {
  readonly isVisible: boolean
  readonly trigger: SlotAttributes<Tooltip.Message>
  readonly panel: SlotAttributes<Tooltip.Message>
  readonly render: Tooltip.RenderInfo
}

const runTooltip = (mixins: TooltipMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: Tooltip.update,
      view: (model, h) =>
        Tooltip.view(
          model,
          {
            anchor: {},
            toView: render => {
              const resolved = TooltipAdapter.resolve(render, mixins, { input: undefined, h })
              capture({
                isVisible: resolved.isVisible,
                trigger: resolved.trigger,
                panel: resolved.panel,
                render,
              })
              return h.div([...resolved.trigger], [])
            },
          },
          h,
        ),
    },
    Scene.given(Tooltip.init({ id: 'test-tooltip' })),
  )
}

describe('Tooltip adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runTooltip([], value => {
      captured = value
    })
    const view = captured!
    expect(view.isVisible).toBe(false)
    for (const child of view.render.trigger) expect(holds(view.trigger, child)).toBe(true)
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
  })

  it('styles a slot without rebuilding its ChildAttributes', () => {
    const PanelStyle = Style.forSlots(TooltipSlots)({ panel: Style.class('tooltip-panel') })
    let captured: Captured | undefined
    runTooltip([PanelStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
    expect(classValue(view.panel)).toBe('tooltip-panel')
  })

  it('refuses a Behavior that takes over the trigger focus', () => {
    const Steal = Behavior.forSlots(TooltipSlots)<undefined, Tooltip.Message>({
      trigger: Behavior.slot({
        requires: { events: [Event.Focus] },
        attributes: ({ h }: { readonly h: HtmlBuilder<Tooltip.Message> }) => [
          h.OnFocus(Tooltip.Message.FocusedTrigger()),
        ],
      }),
    })
    expect(() => runTooltip([Steal.mixin], () => {})).toThrow(Diagnostics.DiagnosticError)
  })
})
