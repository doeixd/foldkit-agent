import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as SliderUi from '@foldkit/ui/slider'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { Slider, SliderSlots } from '../src/index.js'

type SliderMixins = ReadonlyArray<MixinValue<SliderUi.Message> | MixinValue<never>>

interface Captured {
  readonly root: SlotAttributes<SliderUi.Message>
  readonly track: SlotAttributes<SliderUi.Message>
  readonly filledTrack: SlotAttributes<SliderUi.Message>
  readonly thumb: SlotAttributes<SliderUi.Message>
  readonly label: SlotAttributes<SliderUi.Message>
  readonly hiddenInput: SlotAttributes<SliderUi.Message>
  readonly render: SliderUi.SliderAttributes
}

/**
 * `Slider.view` publishes its groups through `childAttributes`, which throws
 * outside a runtime frame. `Scene.scene` supplies that frame and the real `h`,
 * so `toView` receives real ChildAttributes rather than a synthetic brand.
 */
const runSlider = (mixins: SliderMixins, capture: (captured: Captured) => void): void => {
  Scene.scene(
    {
      update: SliderUi.update,
      view: (model, h) =>
        SliderUi.view(
          model,
          {
            value: 50,
            ariaLabel: 'Volume',
            name: 'volume',
            toView: render => {
              const resolved = Slider.resolve(render, mixins, { input: undefined, h })
              capture({
                root: resolved.root,
                track: resolved.track,
                filledTrack: resolved.filledTrack,
                thumb: resolved.thumb,
                label: resolved.label,
                hiddenInput: resolved.hiddenInput,
                render,
              })
              return h.div([...resolved.root], [])
            },
          },
          h,
        ),
    },
    Scene.given(SliderUi.init({ id: 'test-slider', min: 0, max: 100, step: 1 })),
  )
}

const holds = (
  attributes: SlotAttributes<SliderUi.Message>,
  child: SlotAttributes<SliderUi.Message>[number],
): boolean => attributes.includes(child)

/** Every base child survives resolution in the resolved bundle. */
const preserves = (
  base: ReadonlyArray<SlotAttributes<SliderUi.Message>[number]>,
  resolved: SlotAttributes<SliderUi.Message>,
): void => {
  for (const child of base) expect(holds(resolved, child)).toBe(true)
}

const classValue = (attributes: SlotAttributes<SliderUi.Message>): string | undefined => {
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

describe('Slider adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runSlider([], value => {
      captured = value
    })
    const view = captured!
    expect(Object.hasOwn(view.render.track[0] as object, '__childAttribute')).toBe(true)
    preserves(view.render.root, view.root)
    preserves(view.render.track, view.track)
    preserves(view.render.filledTrack, view.filledTrack)
    preserves(view.render.thumb, view.thumb)
    preserves(view.render.label, view.label)
    preserves(view.render.hiddenInput, view.hiddenInput)
  })

  it('styles a slot without rebuilding its ChildAttributes', () => {
    const TrackStyle = Style.forSlots(SliderSlots)({ track: Style.class('slider-track') })
    let captured: Captured | undefined
    runSlider([TrackStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    preserves(view.render.track, view.track)
    expect(classValue(view.track)).toBe('slider-track')
  })

  it('refuses a Behavior that takes over the track pointerdown', () => {
    const diagnostic = diagnosticFrom(() => {
      const Steal = Behavior.forSlots(SliderSlots)<undefined, SliderUi.Message>({
        track: Behavior.slot({
          requires: { events: [Event.PointerDown] },
          attributes: ({ h }: { readonly h: HtmlBuilder<SliderUi.Message> }) => [
            h.OnPointerDown(() => Option.none()),
          ],
        }),
      })
      runSlider([Steal.mixin], () => {})
    })
    expect(diagnostic?.code).toBe('mixins:event-conflict')
  })
})
