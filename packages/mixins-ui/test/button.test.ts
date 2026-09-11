import { describe, expect, it } from 'vitest'
import { view as buttonView, type ViewConfig } from '@foldkit/ui/button'
import { Behavior, Diagnostics, Event, Style, type SlotAttributes } from 'foldkit-mixins'
import { Button, ButtonSlots } from '../src/index.js'
import { attributeOf, h, message, tagsOf, type Mixins, type TestMessage } from './fixture.js'

const renderButton = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): SlotAttributes<TestMessage> => {
  let captured: SlotAttributes<TestMessage> = []
  buttonView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Button.resolve(attributes, mixins, { input: undefined, h }).button
        return h.button(captured, [])
      },
    },
    h,
  )
  return captured
}

describe('Button adapter', () => {
  it('preserves the base accessibility attributes and click Message', () => {
    const clicked = message('Clicked')
    const button = renderButton({ onClick: clicked })
    expect(tagsOf(button)).toContain('Type')
    expect(tagsOf(button)).toContain('Tabindex')
    expect(attributeOf(button, 'Type')?.value).toBe('button')
    expect(attributeOf(button, 'OnClick')?.message).toBe(clicked)
  })

  it('adds a Style class without disturbing the base bundle', () => {
    const SaveStyle = Style.forSlots(ButtonSlots)({ button: Style.class('save') })
    const button = renderButton({ onClick: message('Clicked') }, [SaveStyle.mixin])
    expect(attributeOf(button, 'Class')?.value).toBe('save')
    expect(attributeOf(button, 'OnClick')).toBeDefined()
  })

  it('refuses a Behavior that takes over the base click', () => {
    const Steal = Behavior.forSlots(ButtonSlots)<undefined, TestMessage>({
      button: Behavior.slot({
        requires: { events: [Event.Click] },
        attributes: () => [h.OnClick(message('Other'))],
      }),
    })
    expect(() => renderButton({ onClick: message('Clicked') }, [Steal.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })

  it('allows a Behavior to add a click when the base has none', () => {
    const Add = Behavior.forSlots(ButtonSlots)<undefined, TestMessage>({
      button: Behavior.slot({ attributes: () => [h.OnClick(message('Other'))] }),
    })
    const button = renderButton({}, [Add.mixin])
    expect(attributeOf(button, 'OnClick')?.message).toEqual(message('Other'))
  })

  it('keeps the disabled state owned by the base', () => {
    expect(attributeOf(renderButton({ isDisabled: true }), 'AriaDisabled')?.value).toBe(true)
    const Replace = Behavior.forSlots(ButtonSlots)<undefined, TestMessage>({
      button: Behavior.slot({ attributes: () => [h.AriaDisabled(false)] }),
    })
    expect(() => renderButton({ isDisabled: true }, [Replace.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })
})
