import { describe, expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import { Mixin, SlotView, type SlotAttributes } from '../src/index.js'
import { DiagnosticError } from '../src/diagnostics.js'
import { FieldSlots } from './fixture.js'
import { h, type TestMessage } from './resolverFixture.js'

interface FieldInput {
  readonly label: string
}

const FieldView = SlotView.define(
  FieldSlots,
  (input: FieldInput, slots, h: HtmlBuilder<TestMessage>) =>
    h.div(slots.root.attrs(), [
      h.span(slots.label.attrs(), [input.label]),
      h.input(slots.input.attrs()),
    ]),
  { name: 'Field' },
)

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

const hasTag = (attributes: SlotAttributes<TestMessage>, tag: string): boolean =>
  attributes.some(
    attribute =>
      typeof attribute === 'object' &&
      attribute !== null &&
      '_tag' in attribute &&
      (attribute as { readonly _tag: string })._tag === tag,
  )

const vnodeData = (value: unknown): Record<string, unknown> =>
  (value as { readonly data?: Record<string, unknown> }).data ?? {}

const context = { input: { label: 'x' }, h }

describe('SlotView', () => {
  it('folds a Mixin into the addressed slot only', () => {
    const Decoration = Mixin.make<TestMessage>('Decoration', {
      root: { classes: ['field'] },
      input: { classes: ['field-input'] },
    })
    const builders = SlotView.buildersFor(FieldSlots, [Decoration], context)
    expect(classValue(builders.root.attrs())).toBe('field')
    expect(classValue(builders.input.attrs())).toBe('field-input')
    expect(classValue(builders.label.attrs())).toBeUndefined()
  })

  it('extends base attributes rather than replacing them', () => {
    const Decoration = Mixin.make<TestMessage>('Decoration', { root: { classes: ['field'] } })
    const builders = SlotView.buildersFor(FieldSlots, [Decoration], context)
    const attributes = builders.root.attrs([h.Class('base'), h.Role('group')])
    expect(classValue(attributes)).toBe('base field')
    expect(hasTag(attributes, 'Role')).toBe(true)
  })

  it('merges multiple attachments in order', () => {
    const A = Mixin.make<TestMessage>('A', { root: { classes: ['a'] } })
    const B = Mixin.make<TestMessage>('B', { root: { classes: ['b'] } })
    const builders = SlotView.buildersFor(FieldSlots, [A, B], context)
    expect(classValue(builders.root.attrs())).toBe('a b')
  })

  it('attach returns a new view without mutating the original', () => {
    const Decoration = Mixin.make<TestMessage>('Decoration', { root: { classes: ['field'] } })
    const styled = FieldView.pipe(SlotView.attach(Decoration))
    expect(FieldView.mixins).toHaveLength(0)
    expect(styled.mixins).toHaveLength(1)
    expect(styled).not.toBe(FieldView)
    expect(styled.name).toBe('Field')
  })

  it('renders the attached class into ordinary Foldkit markup', () => {
    const Decoration = Mixin.make<TestMessage>('Decoration', { root: { classes: ['field'] } })
    const html = FieldView.pipe(SlotView.attach(Decoration))({ label: 'Name' }, h)
    expect(vnodeData(html).class).toMatchObject({ field: true })
  })

  it('throws when an attached Mixin conflicts with the view base', () => {
    const Steal = Mixin.make<TestMessage>('Steal', {
      input: { attributes: [h.OnClick({ _tag: 'Clicked' })] },
    })
    const View = SlotView.define(
      FieldSlots,
      (_input: FieldInput, slots, h: HtmlBuilder<TestMessage>) =>
        h.input(slots.input.attrs([h.OnClick({ _tag: 'Other' })])),
    ).pipe(SlotView.attach(Steal))
    expect(() => View({ label: 'x' }, h)).toThrow(DiagnosticError)
  })
})
