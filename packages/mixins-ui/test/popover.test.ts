import { describe, expect, it } from 'vitest'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as Popover from '@foldkit/ui/popover'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Popover as PopoverAdapter, PopoverSlots } from '../src/index.js'

type PopoverMixins = ReadonlyArray<MixinValue<Popover.Message> | MixinValue<never>>

interface Captured {
  readonly isVisible: boolean
  readonly button: SlotAttributes<Popover.Message>
  readonly panel: SlotAttributes<Popover.Message>
  readonly backdrop: SlotAttributes<Popover.Message>
  readonly arrow: SlotAttributes<Popover.Message>
  readonly render: Popover.RenderInfo
}

const runPopover = (mixins: PopoverMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: Popover.update,
      view: (model, h) =>
        Popover.view(
          model,
          {
            anchor: {},
            toView: render => {
              const resolved = PopoverAdapter.resolve(render, mixins, { input: undefined, h })
              capture({
                isVisible: resolved.isVisible,
                button: resolved.button,
                panel: resolved.panel,
                backdrop: resolved.backdrop,
                arrow: resolved.arrow,
                render,
              })
              return h.div([...resolved.button], [])
            },
          },
          h,
        ),
    },
    Scene.given(Popover.init({ id: 'test-popover' })),
  )
}

const classValue = (attributes: SlotAttributes<Popover.Message>): string | undefined => {
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

const holds = (
  attributes: SlotAttributes<Popover.Message>,
  child: SlotAttributes<Popover.Message>[number],
): boolean => attributes.includes(child)

describe('Popover adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runPopover([], value => {
      captured = value
    })
    const view = captured!
    expect(view.isVisible).toBe(false)
    for (const child of view.render.button) expect(holds(view.button, child)).toBe(true)
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
    for (const child of view.render.backdrop) expect(holds(view.backdrop, child)).toBe(true)
    for (const child of view.render.arrow) expect(holds(view.arrow, child)).toBe(true)
  })

  it('styles a slot without rebuilding its ChildAttributes', () => {
    const PanelStyle = Style.forSlots(PopoverSlots)({ panel: Style.class('popover-panel') })
    let captured: Captured | undefined
    runPopover([PanelStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
    expect(classValue(view.panel)).toBe('popover-panel')
  })

  it('refuses a Behavior that takes over the trigger click', () => {
    const Steal = Behavior.forSlots(PopoverSlots)<undefined, Popover.Message>({
      button: Behavior.slot({
        requires: { events: [Event.Click] },
        attributes: ({ h }: { readonly h: HtmlBuilder<Popover.Message> }) => [
          h.OnClick(Popover.Message.RequestedOpen()),
        ],
      }),
    })
    expect(() => runPopover([Steal.mixin], () => {})).toThrow(Diagnostics.DiagnosticError)
  })
})
