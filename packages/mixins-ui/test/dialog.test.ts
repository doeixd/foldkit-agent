import { describe, expect, it } from 'vitest'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as Dialog from '@foldkit/ui/dialog'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Dialog as DialogAdapter, DialogSlots } from '../src/index.js'
import { classValue, holds } from './fixture.js'

type DialogMixins = ReadonlyArray<MixinValue<Dialog.Message> | MixinValue<never>>

interface Captured {
  readonly isVisible: boolean
  readonly dialog: SlotAttributes<Dialog.Message>
  readonly panel: SlotAttributes<Dialog.Message>
  readonly closeButton: SlotAttributes<Dialog.Message>
  readonly render: Dialog.RenderInfo
}

/**
 * `Dialog.view` publishes its groups through `childAttributes`, which throws
 * outside a runtime frame. `Scene.scene` supplies that frame and the real `h`,
 * so `toView` receives real ChildAttributes rather than a synthetic brand.
 */
const runDialog = (mixins: DialogMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: Dialog.update,
      view: (model, h) =>
        Dialog.view(
          model,
          {
            toView: render => {
              const resolved = DialogAdapter.resolve(render, mixins, { input: undefined, h })
              capture({
                isVisible: resolved.isVisible,
                dialog: resolved.dialog,
                panel: resolved.panel,
                closeButton: resolved.closeButton,
                render,
              })
              return h.div([...resolved.panel], [])
            },
          },
          h,
        ),
    },
    Scene.given(Dialog.init({ id: 'test-dialog', isOpen: true })),
  )
}

describe('Dialog adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runDialog([], value => {
      captured = value
    })
    const view = captured!
    expect(view.isVisible).toBe(true)
    expect(Object.hasOwn(view.render.panel[0] as object, '__childAttribute')).toBe(true)
    for (const child of view.render.dialog) expect(holds(view.dialog, child)).toBe(true)
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
  })

  it('styles a slot without rebuilding its ChildAttributes', () => {
    const PanelStyle = Style.forSlots(DialogSlots)({ panel: Style.class('dialog-panel') })
    let captured: Captured | undefined
    runDialog([PanelStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    for (const child of view.render.panel) expect(holds(view.panel, child)).toBe(true)
    expect(classValue(view.panel)).toBe('dialog-panel')
  })

  it('refuses a Behavior that takes over the close button click', () => {
    const Steal = Behavior.forSlots(DialogSlots)<undefined, Dialog.Message>({
      closeButton: Behavior.slot({
        requires: { events: [Event.Click] },
        attributes: ({ h }: { readonly h: HtmlBuilder<Dialog.Message> }) => [
          h.OnClick(Dialog.Message.RequestedClose()),
        ],
      }),
    })
    expect(() => runDialog([Steal.mixin], () => {})).toThrow(Diagnostics.DiagnosticError)
  })
})
