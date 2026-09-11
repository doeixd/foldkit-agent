import { describe, expect, it } from 'vitest'
import { view as switchView, type ViewConfig } from '@foldkit/ui/switch'
import { Behavior, Diagnostics, Event, Style, type SlotAttributes } from 'foldkit-mixins'
import { Switch, SwitchSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedSwitch {
  readonly button: SlotAttributes<TestMessage>
  readonly label: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
  readonly hiddenInput: SlotAttributes<TestMessage>
}

const renderSwitch = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedSwitch => {
  let captured: ResolvedSwitch = { button: [], label: [], description: [], hiddenInput: [] }
  switchView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Switch.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

const basic = {
  id: 'notifications',
  isChecked: false,
  onToggle: () => message('Other'),
}

describe('Switch adapter', () => {
  it('preserves the base control bundle and toggle Message', () => {
    const view = renderSwitch(basic)
    expect(attributeOf(view.button, 'Role')?.value).toBe('switch')
    expect(attributeOf(view.button, 'AriaChecked')?.value).toBe(false)
    expect(attributeOf(view.button, 'OnClick')?.message).toEqual(message('Other'))
  })

  it('fills the hidden input bundle when a form name is set', () => {
    const view = renderSwitch({ ...basic, isChecked: true, name: 'notifications' })
    expect(attributeOf(view.hiddenInput, 'Type')?.value).toBe('hidden')
    expect(attributeOf(view.hiddenInput, 'Name')?.value).toBe('notifications')
    expect(attributeOf(view.hiddenInput, 'Value')?.value).toBe('on')
  })

  it('adds Style to the label slot', () => {
    const LabelStyle = Style.forSlots(SwitchSlots)({ label: Style.class('switch-label') })
    expect(attributeOf(renderSwitch(basic, [LabelStyle.mixin]).label, 'Class')?.value).toBe(
      'switch-label',
    )
  })

  it('refuses a Behavior that takes over the control click', () => {
    const Steal = Behavior.forSlots(SwitchSlots)<undefined, TestMessage>({
      button: Behavior.slot({
        requires: { events: [Event.Click] },
        attributes: () => [h.OnClick(message('Other'))],
      }),
    })
    expect(() => renderSwitch(basic, [Steal.mixin])).toThrow(Diagnostics.DiagnosticError)
  })
})
