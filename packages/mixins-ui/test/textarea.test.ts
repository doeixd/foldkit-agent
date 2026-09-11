import { describe, expect, it } from 'vitest'
import { view as textareaView, type ViewConfig } from '@foldkit/ui/textarea'
import { Attr, Behavior, Diagnostics, Style, type SlotAttributes } from 'foldkit-mixins'
import { Textarea, TextareaSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedTextarea {
  readonly textarea: SlotAttributes<TestMessage>
  readonly label: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
}

const renderTextarea = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedTextarea => {
  let captured: ResolvedTextarea = { textarea: [], label: [], description: [] }
  textareaView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Textarea.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

describe('Textarea adapter', () => {
  it('preserves the base textarea, label, and description bundles', () => {
    const view = renderTextarea({ id: 'bio', value: 'hi', onInput: () => message('Other') })
    expect(attributeOf(view.textarea, 'Id')?.value).toBe('bio')
    expect(attributeOf(view.textarea, 'Value')?.value).toBe('hi')
    expect(attributeOf(view.label, 'For')?.value).toBe('bio')
    expect(attributeOf(view.description, 'Id')?.value).toBe('bio-description')
  })

  it('adds Style to the textarea and label slots independently', () => {
    const BioStyle = Style.forSlots(TextareaSlots)({
      textarea: Style.class('bio'),
      label: Style.class('bio-label'),
    })
    const view = renderTextarea({ id: 'bio' }, [BioStyle.mixin])
    expect(attributeOf(view.textarea, 'Class')?.value).toBe('bio')
    expect(attributeOf(view.label, 'Class')?.value).toBe('bio-label')
  })

  it('keeps a controlled value owned by the base', () => {
    const Replace = Behavior.forSlots(TextareaSlots)<undefined, TestMessage>({
      textarea: Behavior.slot({
        requires: { attributes: [Attr.Value] },
        attributes: () => [h.Value('b')],
      }),
    })
    expect(() => renderTextarea({ id: 'bio', value: 'a' }, [Replace.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })
})
