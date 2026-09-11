import { describe, expect, it } from 'vitest'
import { Capability, Slot, SlotView, Slots, Style, type SlotAttributes } from '../src/index.js'
import { DiagnosticError } from '../src/diagnostics.js'
import { h, type TestMessage } from './resolverFixture.js'

const RuleSlots = Slots.define({ root: Slot.make({ capability: Capability.Container }) })

const classValue = (attributes: SlotAttributes<TestMessage>): string | undefined => {
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

const diagnosticCode = (run: () => unknown): string | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    if (error instanceof DiagnosticError) return error.diagnostic.code
    throw error
  }
}

describe('Style rule compiler', () => {
  it('compiles a pseudo rule to one deterministic class and CSS', () => {
    const Hover = Style.forSlots(RuleSlots)({
      root: Style.pseudo(':hover', { color: 'red' }),
    })
    const builders = SlotView.buildersFor(RuleSlots, [Hover.mixin], { input: undefined, h })
    const generated = classValue(builders.root.attrs())
    expect(generated).toMatch(/^style-[a-z0-9]+$/)
    expect(Hover.css).toBe(`.${generated}:hover{color:red}`)
  })

  it('is declaration-order independent and content sensitive', () => {
    const one = Style.forSlots(RuleSlots)({
      root: Style.pseudo(':hover', { color: 'red', background: 'blue' }),
    })
    const two = Style.forSlots(RuleSlots)({
      root: Style.pseudo(':hover', { background: 'blue', color: 'red' }),
    })
    const other = Style.forSlots(RuleSlots)({
      root: Style.pseudo(':hover', { color: 'blue', background: 'blue' }),
    })
    expect(one.css).toBe(two.css)
    expect(one.css).not.toBe(other.css)
  })

  it('wraps a media rule', () => {
    const Wide = Style.forSlots(RuleSlots)({
      root: Style.media('(min-width: 40rem)', { display: 'grid' }),
    })
    const builders = SlotView.buildersFor(RuleSlots, [Wide.mixin], { input: undefined, h })
    const generated = classValue(builders.root.attrs())
    expect(Wide.css).toBe(`@media (min-width: 40rem){.${generated}{display:grid}}`)
  })

  it('composes rules in authored order', () => {
    const Both = Style.forSlots(RuleSlots)({
      root: Style.compose(
        Style.pseudo(':hover', { color: 'red' }),
        Style.media('(min-width: 40rem)', { display: 'grid' }),
      ),
    })
    expect(Both.css).toContain(':hover{color:red}')
    expect(Both.css).toContain('@media (min-width: 40rem)')
  })

  it('compiles supports, container and nested selectors', () => {
    const Combined = Style.forSlots(RuleSlots)({
      root: Style.compose(
        Style.supports('(display: grid)', { display: 'grid' }),
        Style.container('(min-width: 30rem)', { gridTemplateColumns: '1fr 1fr' }),
        Style.nest('> span', { color: 'red' }),
      ),
    })
    const builders = SlotView.buildersFor(RuleSlots, [Combined.mixin], { input: undefined, h })
    const generated = classValue(builders.root.attrs())
    expect(Combined.css).toBe(
      `@supports (display: grid){.${generated}{display:grid}}` +
        `@container (min-width: 30rem){.${generated}{grid-template-columns:1fr 1fr}}` +
        `.${generated} > span{color:red}`,
    )
  })

  it('shares a class for equal rules and not for different ones', () => {
    const one = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'red' }) })
    const two = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'red' }) })
    const other = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'blue' }) })
    expect(one.css).toBe(two.css)
    expect(one.css).not.toBe(other.css)
  })

  it('rejects rules inside an input condition', () => {
    expect(
      diagnosticCode(() =>
        Style.forSlots(RuleSlots)({
          root: Style.whenInput(() => true, Style.pseudo(':hover', { color: 'red' })),
        }),
      ),
    ).toBe('style:conditional-rules-unsupported')
  })
})
