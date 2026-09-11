import { describe, expect, it } from 'vitest'
import { view as disclosureView, type ViewConfig } from '@foldkit/ui/disclosure'
import type { Html } from 'foldkit/html'
import { Behavior, Diagnostics, Style, type SlotAttributes } from 'foldkit-mixins'
import { Disclosure, DisclosureSlots } from '../src/index.js'
import { attributeOf, h, message, type Mixins, type TestMessage } from './fixture.js'

interface ResolvedDisclosure {
  readonly button: SlotAttributes<TestMessage>
  readonly panel: SlotAttributes<TestMessage>
  readonly animatePanel: (content: Html) => Html
}

interface Rendered {
  readonly view: ResolvedDisclosure
  readonly originalAnimatePanel: (content: Html) => Html
}

const renderDisclosure = (
  config: Omit<ViewConfig<TestMessage>, 'toView'>,
  mixins: Mixins = [],
): Rendered => {
  let view: Rendered['view'] | undefined
  let originalAnimatePanel: ((content: Html) => Html) | undefined
  disclosureView<TestMessage>(
    {
      ...config,
      toView: attributes => {
        originalAnimatePanel = attributes.animatePanel
        view = Disclosure.resolve(attributes, mixins, { input: undefined, h })
        return h.div([], [])
      },
    },
    h,
  )
  return { view: view!, originalAnimatePanel: originalAnimatePanel! }
}

const closed = { id: 'details', isOpen: false, onToggle: () => message('Other') }

describe('Disclosure adapter', () => {
  it('preserves the base button and panel bundles', () => {
    const { view } = renderDisclosure(closed)
    expect(attributeOf(view.button, 'AriaExpanded')?.value).toBe(false)
    expect(attributeOf(view.button, 'OnClick')?.message).toEqual(message('Other'))
    expect(attributeOf(view.panel, 'Id')?.value).toBe('details-panel')
  })

  it('passes animatePanel through by identity', () => {
    const { view, originalAnimatePanel } = renderDisclosure(closed)
    expect(view.animatePanel).toBe(originalAnimatePanel)
  })

  it('adds Style to the panel slot', () => {
    const PanelStyle = Style.forSlots(DisclosureSlots)({ panel: Style.class('panel') })
    const { view } = renderDisclosure(closed, [PanelStyle.mixin])
    expect(attributeOf(view.panel, 'Class')?.value).toBe('panel')
  })

  it('refuses a Behavior that takes over the base click', () => {
    const Steal = Behavior.forSlots(DisclosureSlots)<undefined, TestMessage>({
      button: Behavior.slot({ attributes: () => [h.OnClick(message('Other'))] }),
    })
    expect(() => renderDisclosure(closed, [Steal.mixin])).toThrow(Diagnostics.DiagnosticError)
  })
})
