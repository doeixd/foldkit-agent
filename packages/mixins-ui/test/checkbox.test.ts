import { describe, expect, it } from 'vitest'
import { view as checkboxView, type ViewConfig } from '@foldkit/ui/checkbox'
import { Behavior, Diagnostics, Style, type SlotAttributes } from 'foldkit-mixins'
import { Checkbox, CheckboxSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedCheckbox {
  readonly checkbox: SlotAttributes<TestMessage>
  readonly label: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
  readonly hiddenInput: SlotAttributes<TestMessage>
}

const renderCheckbox = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedCheckbox => {
  let captured: ResolvedCheckbox = { checkbox: [], label: [], description: [], hiddenInput: [] }
  checkboxView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Checkbox.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

const basic = {
  id: 'terms',
  isChecked: false,
  onToggle: () => message('Other'),
}

describe('Checkbox adapter', () => {
  it('preserves the base control attributes and toggle Message', () => {
    const view = renderCheckbox(basic)
    expect(attributeOf(view.checkbox, 'Role')?.value).toBe('checkbox')
    expect(attributeOf(view.checkbox, 'AriaChecked')?.value).toBe(false)
    expect(attributeOf(view.checkbox, 'OnClick')?.message).toEqual(message('Other'))
  })

  it('fills the hidden input bundle when a form name is set', () => {
    const view = renderCheckbox({ ...basic, isChecked: true, name: 'terms', value: 'yes' })
    expect(attributeOf(view.hiddenInput, 'Type')?.value).toBe('hidden')
    expect(attributeOf(view.hiddenInput, 'Name')?.value).toBe('terms')
    expect(attributeOf(view.hiddenInput, 'Value')?.value).toBe('yes')
  })

  it('adds Style to the label slot', () => {
    const LabelStyle = Style.forSlots(CheckboxSlots)({ label: Style.class('terms-label') })
    expect(attributeOf(renderCheckbox(basic, [LabelStyle.mixin]).label, 'Class')?.value).toBe(
      'terms-label',
    )
  })

  it('refuses a Behavior that takes over the control click', () => {
    const Steal = Behavior.forSlots(CheckboxSlots)<undefined, TestMessage>({
      checkbox: Behavior.slot({ attributes: () => [h.OnClick(message('Other'))] }),
    })
    expect(() => renderCheckbox(basic, [Steal.mixin])).toThrow(Diagnostics.DiagnosticError)
  })

  it('refuses a Behavior that takes over the label click', () => {
    const Steal = Behavior.forSlots(CheckboxSlots)<undefined, TestMessage>({
      label: Behavior.slot({ attributes: () => [h.OnClick(message('Other'))] }),
    })
    expect(() => renderCheckbox(basic, [Steal.mixin])).toThrow(Diagnostics.DiagnosticError)
  })
})
