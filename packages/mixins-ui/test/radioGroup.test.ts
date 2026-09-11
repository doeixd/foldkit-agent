import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { Scene } from 'foldkit/test'
import type { HtmlBuilder } from 'foldkit/html'
import * as RadioGroupUi from '@foldkit/ui/radioGroup'
import {
  Behavior,
  Diagnostics,
  Event,
  Style,
  type MixinValue,
  type SlotAttributes,
} from 'foldkit-mixins'
import { RadioGroup, RadioGroupSlots } from '../src/index.js'

const DemoRadio = RadioGroupUi.create<'free' | 'pro'>()

type RadioMixins = ReadonlyArray<MixinValue<RadioGroupUi.Message> | MixinValue<never>>

interface CapturedOption {
  readonly option: SlotAttributes<RadioGroupUi.Message>
  readonly label: SlotAttributes<RadioGroupUi.Message>
  readonly description: SlotAttributes<RadioGroupUi.Message>
}

interface Captured {
  readonly group: SlotAttributes<RadioGroupUi.Message>
  readonly options: ReadonlyArray<CapturedOption>
  readonly selectedValue: Option.Option<'free' | 'pro'>
  readonly hiddenInput: SlotAttributes<RadioGroupUi.Message>
  readonly render: RadioGroupUi.RenderInfo<'free' | 'pro'>
}

interface RunOptions {
  readonly selectedValue?: Option.Option<'free' | 'pro'>
  readonly name?: string
}

/**
 * `RadioGroup.view` publishes its groups through `childAttributes`, which
 * throws outside a runtime frame. `Scene.scene` supplies that frame and the
 * real `h`, so `toView` receives real ChildAttributes rather than a synthetic
 * brand.
 */
const runRadio = (
  mixins: RadioMixins,
  capture: (captured: Captured) => void,
  options: RunOptions = {},
): void => {
  const { selectedValue = Option.none(), name } = options
  Scene.scene(
    {
      update: DemoRadio.update,
      view: (model, h) =>
        DemoRadio.view(
          model,
          {
            options: ['free', 'pro'] as const,
            selectedValue,
            ariaLabel: 'Plan',
            ...(name === undefined ? {} : { name }),
            toView: render => {
              const resolved = RadioGroup.resolve(render, mixins, { input: undefined, h })
              capture({
                group: resolved.group,
                options: resolved.options.map(item => ({
                  option: item.option,
                  label: item.label,
                  description: item.description,
                })),
                selectedValue: resolved.selectedValue,
                hiddenInput: resolved.hiddenInput,
                render,
              })
              return h.div(
                [...resolved.group],
                resolved.options.map(item => h.button([...item.option], [])),
              )
            },
          },
          h,
        ),
    },
    Scene.given(RadioGroupUi.init({ id: 'test-radio' })),
  )
}

const classValue = (attributes: SlotAttributes<RadioGroupUi.Message>): string | undefined => {
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

describe('RadioGroup adapter', () => {
  it('preserves the real ChildAttribute bundles by identity', () => {
    let captured: Captured | undefined
    runRadio(
      [],
      value => {
        captured = value
      },
      { selectedValue: Option.some('free'), name: 'plan' },
    )
    const view = captured!
    expect(view.selectedValue).toEqual(Option.some('free'))
    expect(Object.hasOwn(view.render.group[0] as object, '__childAttribute')).toBe(true)
    for (const child of view.render.group) expect(view.group.includes(child)).toBe(true)
    expect(view.options).toHaveLength(2)
    view.render.options.forEach((base, index) => {
      const resolved = view.options[index]!
      for (const child of base.option) expect(resolved.option.includes(child)).toBe(true)
      for (const child of base.label) expect(resolved.label.includes(child)).toBe(true)
      for (const child of base.description) expect(resolved.description.includes(child)).toBe(true)
    })
    for (const child of view.render.hiddenInput) expect(view.hiddenInput.includes(child)).toBe(true)
  })

  it('styles every option without rebuilding its ChildAttributes', () => {
    const OptionStyle = Style.forSlots(RadioGroupSlots)({ option: Style.class('plan-radio') })
    let captured: Captured | undefined
    runRadio([OptionStyle.mixin], value => {
      captured = value
    })
    const view = captured!
    view.options.forEach((resolved, index) => {
      for (const child of view.render.options[index]!.option) {
        expect(resolved.option.includes(child)).toBe(true)
      }
      expect(classValue(resolved.option)).toBe('plan-radio')
    })
  })

  it('refuses a Behavior that takes over an option click', () => {
    const diagnostic = diagnosticFrom(() => {
      const Steal = Behavior.forSlots(RadioGroupSlots)<undefined, RadioGroupUi.Message>({
        option: Behavior.slot({
          requires: { events: [Event.Click] },
          attributes: ({ h }: { readonly h: HtmlBuilder<RadioGroupUi.Message> }) => [
            h.OnClick(RadioGroupUi.Message.SelectedOption({ index: 0, value: 'free' })),
          ],
        }),
      })
      runRadio([Steal.mixin], () => {})
    })
    expect(diagnostic?.code).toBe('mixins:event-conflict')
  })
})
