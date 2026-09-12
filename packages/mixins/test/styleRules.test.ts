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

  it('does not evaluate an input predicate until render', () => {
    const calls: Array<number> = []
    const Conditional = Style.forSlots(RuleSlots)({
      root: Style.whenInput<{ readonly n: number }>(input => {
        calls.push(input.n)
        return input.n > 0
      }, Style.class('positive')),
    })
    expect(calls).toEqual([])

    const active = SlotView.buildersFor(RuleSlots, [Conditional.mixin], { input: { n: 1 }, h })
    expect(classValue(active.root.attrs())).toBe('positive')
    expect(calls).toEqual([1])

    const inactive = SlotView.buildersFor(RuleSlots, [Conditional.mixin], { input: { n: 0 }, h })
    expect(classValue(inactive.root.attrs())).toBeUndefined()
  })

  it('compiles deterministic keyframes and puts them in globalCss', () => {
    const Fade = Style.keyframes({ from: { opacity: '0' }, to: { opacity: '1' } })
    expect(Fade.name).toMatch(/^kf-[a-z0-9]+$/)
    const Reveal = Style.forSlots(RuleSlots)({
      root: Style.compose(Fade.style, Style.inline({ animation: `${Fade.name} 200ms` })),
    })
    expect(Reveal.globalCss).toBe(`@keyframes ${Fade.name}{from{opacity:0}to{opacity:1}}`)
    expect(Reveal.css).toBe('')
    expect(Style.keyframes({ from: { opacity: '0' }, to: { opacity: '1' } }).name).toBe(Fade.name)
    expect(Style.keyframes({ from: { opacity: '0' }, to: { opacity: '0.5' } }).name).not.toBe(
      Fade.name,
    )
  })

  it('carries raw global CSS and joins it before scoped rules', () => {
    const Base = Style.forSlots(RuleSlots)({
      root: Style.compose(Style.global('@layer base{}'), Style.pseudo(':hover', { color: 'red' })),
    })
    expect(Base.globalCss).toBe('@layer base{}')
    const builders = SlotView.buildersFor(RuleSlots, [Base.mixin], { input: undefined, h })
    const generated = classValue(builders.root.attrs())
    expect(Style.stylesheet(Base)).toBe(`@layer base{}.${generated}:hover{color:red}`)
  })

  it('keeps top-level rule CSS when the style also has an input condition', () => {
    const Mixed = Style.forSlots(RuleSlots)({
      root: Style.compose(
        Style.pseudo(':hover', { color: 'red' }),
        Style.whenInput<{ readonly on: boolean }>(input => input.on, Style.class('on')),
      ),
    })
    expect(Mixed.css).toContain(':hover{color:red}')
  })

  it('emits global CSS contributed by a conditional piece', () => {
    const Fade = Style.keyframes({ from: { opacity: '0' }, to: { opacity: '1' } })
    const Mixed = Style.forSlots(RuleSlots)({
      root: Style.whenInput<{ readonly on: boolean }>(input => input.on, Fade.style),
    })
    expect(Mixed.globalCss).toContain('@keyframes')
  })

  it('composes rule-bearing recipe variants', () => {
    const Recipe = Style.recipe({
      base: Style.class('button'),
      variants: {
        intent: {
          primary: Style.pseudo(':hover', { color: 'red' }),
          ghost: Style.class('ghost'),
        },
      },
    })
    const Primary = Style.forSlots(RuleSlots)({ root: Recipe({ intent: 'primary' }) })
    const Ghost = Style.forSlots(RuleSlots)({ root: Recipe({ intent: 'ghost' }) })
    expect(Primary.css).toContain(':hover{color:red}')
    expect(Ghost.css).toBe('')
  })

  it('deduplicates identical scoped rules across styles', () => {
    const a = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'red' }) })
    const b = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'red' }) })
    const c = Style.forSlots(RuleSlots)({ root: Style.pseudo(':hover', { color: 'blue' }) })
    expect(Style.stylesheet(a, b)).toBe(a.css)
    const both = Style.stylesheet(a, c)
    expect(both).toContain('color:red')
    expect(both).toContain('color:blue')
    expect(both).toHaveLength(a.css.length + c.css.length)
  })

  it('deduplicates shared keyframes across styles', () => {
    const Fade = Style.keyframes({ from: { opacity: '0' }, to: { opacity: '1' } })
    const a = Style.forSlots(RuleSlots)({ root: Fade.style })
    const b = Style.forSlots(RuleSlots)({ root: Fade.style })
    expect(Style.stylesheet(a, b)).toBe(`@keyframes ${Fade.name}{from{opacity:0}to{opacity:1}}`)
  })

  it('compiles identically across independent evaluations', () => {
    const build = () =>
      Style.forSlots(RuleSlots)({
        root: Style.compose(
          Style.pseudo(':hover', { color: 'red' }),
          Style.media('(min-width: 40rem)', { display: 'grid' }),
        ),
      })
    const a = build()
    const b = build()
    expect(a.css).toBe(b.css)
    expect(a.rules.map(rule => rule.className)).toEqual(b.rules.map(rule => rule.className))
    expect(Style.stylesheet(a)).toBe(Style.stylesheet(b))
  })
})
