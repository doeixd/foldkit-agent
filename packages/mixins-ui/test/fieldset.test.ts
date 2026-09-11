import { describe, expect, it } from 'vitest'
import { view as fieldsetView, type ViewConfig } from '@foldkit/ui/fieldset'
import { Attr, Behavior, Diagnostics, Style, type SlotAttributes } from 'foldkit-mixins'
import { Fieldset, FieldsetSlots } from '../src/index.js'
import { attributeOf, h, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedFieldset {
  readonly fieldset: SlotAttributes<TestMessage>
  readonly legend: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
}

const renderFieldset = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedFieldset => {
  let captured: ResolvedFieldset = { fieldset: [], legend: [], description: [] }
  fieldsetView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Fieldset.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

describe('Fieldset adapter', () => {
  it('preserves the base fieldset, legend, and description bundles', () => {
    const view = renderFieldset({ id: 'shipping' })
    expect(attributeOf(view.fieldset, 'Id')?.value).toBe('shipping')
    expect(attributeOf(view.legend, 'Id')?.value).toBe('shipping-legend')
    expect(attributeOf(view.description, 'Id')?.value).toBe('shipping-description')
    expect(attributeOf(view.fieldset, 'AriaDescribedBy')?.value).toBe('shipping-description')
  })

  it('adds Style to the legend slot', () => {
    const LegendStyle = Style.forSlots(FieldsetSlots)({ legend: Style.class('legend') })
    expect(
      attributeOf(renderFieldset({ id: 'shipping' }, [LegendStyle.mixin]).legend, 'Class')?.value,
    ).toBe('legend')
  })

  it('keeps the disabled state owned by the base', () => {
    expect(
      attributeOf(renderFieldset({ id: 'shipping', isDisabled: true }).fieldset, 'Disabled')?.value,
    ).toBe(true)
    const Replace = Behavior.forSlots(FieldsetSlots)<undefined, TestMessage>({
      fieldset: Behavior.slot({
        requires: { attributes: [Attr.Disabled] },
        attributes: () => [h.Disabled(false)],
      }),
    })
    expect(() => renderFieldset({ id: 'shipping', isDisabled: true }, [Replace.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })
})
