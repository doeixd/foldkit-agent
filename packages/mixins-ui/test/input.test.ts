import { describe, expect, it } from 'vitest'
import { view as inputView, type ViewConfig } from '@foldkit/ui/input'
import { Attr, Behavior, Capability, Diagnostics, Style, type SlotAttributes } from 'foldkit-mixins'
import { Input, InputSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedInput {
  readonly input: SlotAttributes<TestMessage>
  readonly label: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
}

const renderInput = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedInput => {
  let captured: ResolvedInput = { input: [], label: [], description: [] }
  inputView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Input.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

describe('Input adapter', () => {
  it('preserves the base input, label, and description bundles', () => {
    const view = renderInput({ id: 'email', value: 'a', onInput: () => message('Other') })
    expect(attributeOf(view.input, 'Id')?.value).toBe('email')
    expect(attributeOf(view.input, 'Type')?.value).toBe('text')
    expect(attributeOf(view.input, 'Value')?.value).toBe('a')
    expect(attributeOf(view.label, 'For')?.value).toBe('email')
    expect(attributeOf(view.description, 'Id')?.value).toBe('email-description')
  })

  it('adds Style to the input and label slots independently', () => {
    const FieldStyle = Style.forSlots(InputSlots)({
      input: Style.class('field'),
      label: Style.class('field-label'),
    })
    const view = renderInput({ id: 'email' }, [FieldStyle.mixin])
    expect(attributeOf(view.input, 'Class')?.value).toBe('field')
    expect(attributeOf(view.label, 'Class')?.value).toBe('field-label')
    expect(attributeOf(view.description, 'Class')).toBeUndefined()
  })

  it('lets a Behavior requiring TextInput attach to the input', () => {
    const Validate = Behavior.forSlots(InputSlots)<undefined, TestMessage>({
      input: Behavior.slot({
        requires: { capability: Capability.TextInput },
        attributes: () => [h.AriaInvalid(true)],
      }),
    })
    const view = renderInput({ id: 'email' }, [Validate.mixin])
    expect(attributeOf(view.input, 'AriaInvalid')?.value).toBe(true)
  })

  it('rejects a Behavior requiring TextInput on the label', () => {
    expect(() =>
      Behavior.forSlots(InputSlots)<undefined, TestMessage>({
        label: Behavior.slot({ requires: { capability: Capability.TextInput } }),
      }),
    ).toThrow(Diagnostics.DiagnosticError)
  })

  it('keeps a controlled value owned by the base', () => {
    const Replace = Behavior.forSlots(InputSlots)<undefined, TestMessage>({
      input: Behavior.slot({
        requires: { attributes: [Attr.Value] },
        attributes: () => [h.Value('b')],
      }),
    })
    expect(() => renderInput({ id: 'email', value: 'a' }, [Replace.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })
})
