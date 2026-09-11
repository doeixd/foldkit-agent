import { describe, expect, it } from 'vitest'
import { view as selectView, type ViewConfig } from '@foldkit/ui/select'
import { Attr, Behavior, Diagnostics, Event, Style, type SlotAttributes } from 'foldkit-mixins'
import { Select, SelectSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedSelect {
  readonly select: SlotAttributes<TestMessage>
  readonly label: SlotAttributes<TestMessage>
  readonly description: SlotAttributes<TestMessage>
}

const renderSelect = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): ResolvedSelect => {
  let captured: ResolvedSelect = { select: [], label: [], description: [] }
  selectView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        captured = Select.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return captured
}

describe('Select adapter', () => {
  it('preserves the base select, label, and description bundles', () => {
    const view = renderSelect({ id: 'fruit', value: 'apple', onChange: () => message('Other') })
    expect(attributeOf(view.select, 'Id')?.value).toBe('fruit')
    expect(attributeOf(view.select, 'Value')?.value).toBe('apple')
    expect(attributeOf(view.select, 'AriaDescribedBy')?.value).toBe('fruit-description')
    expect(attributeOf(view.label, 'For')?.value).toBe('fruit')
    expect(attributeOf(view.description, 'Id')?.value).toBe('fruit-description')
  })

  it('adds Style to the select slot only', () => {
    const FruitStyle = Style.forSlots(SelectSlots)({ select: Style.class('fruit') })
    const view = renderSelect({ id: 'fruit' }, [FruitStyle.mixin])
    expect(attributeOf(view.select, 'Class')?.value).toBe('fruit')
    expect(attributeOf(view.label, 'Class')).toBeUndefined()
    expect(attributeOf(view.description, 'Class')).toBeUndefined()
  })

  it('keeps a controlled value owned by the base', () => {
    const Replace = Behavior.forSlots(SelectSlots)<undefined, TestMessage>({
      select: Behavior.slot({
        requires: { attributes: [Attr.Value] },
        attributes: () => [h.Value('b')],
      }),
    })
    expect(() => renderSelect({ id: 'fruit', value: 'apple' }, [Replace.mixin])).toThrow(
      Diagnostics.DiagnosticError,
    )
  })

  it('refuses a Behavior that takes over the base change handler', () => {
    const Steal = Behavior.forSlots(SelectSlots)<undefined, TestMessage>({
      select: Behavior.slot({
        requires: { events: [Event.Change] },
        attributes: () => [h.OnChange(() => message('Other'))],
      }),
    })
    expect(() =>
      renderSelect({ id: 'fruit', onChange: () => message('Clicked') }, [Steal.mixin]),
    ).toThrow(Diagnostics.DiagnosticError)
  })
})
