import { describe, expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import { SlotView, Style } from '../src/index.js'
import { DiagnosticError } from '../src/diagnostics.js'
import { FieldSlots } from './fixture.js'
import { h, type TestMessage } from './resolverFixture.js'

interface FieldInput {
  readonly label: string
}

const vnodeData = (value: unknown): Record<string, unknown> =>
  (value as { readonly data?: Record<string, unknown> }).data ?? {}

const FieldView = SlotView.define(
  FieldSlots,
  (_input: FieldInput, slots, h: HtmlBuilder<TestMessage>) =>
    h.div(slots.root.attrs(), [h.input(slots.input.attrs())]),
)

describe('Style', () => {
  it('composes classes additively and inline styles per property', () => {
    const piece = Style.compose(
      Style.class('a b'),
      Style.inline({ color: 'red', gap: '1px' }),
      Style.class('b c'),
      Style.inline({ color: 'blue' }),
    )
    expect(piece.classes).toEqual(['a', 'b', 'b', 'c'])
    expect(piece.style).toEqual({ color: 'blue', gap: '1px' })
  })

  it('when is empty for a false condition and the piece otherwise', () => {
    expect(Style.when(false, Style.class('x'))).toBe(Style.empty)
    expect(Style.when(true, Style.class('x')).classes).toEqual(['x'])
  })

  it('forSlots compiles pieces into one Mixin', () => {
    const FieldStyle = Style.forSlots(FieldSlots)(
      {
        root: Style.compose(Style.class('field'), Style.inline({ display: 'grid' })),
        input: Style.class('field-input'),
      },
      { name: 'FieldStyle' },
    )
    expect(FieldStyle.mixin.name).toBe('FieldStyle')
    expect(FieldStyle.pieces.root?.classes).toEqual(['field'])
    expect(FieldStyle.pieces.input?.classes).toEqual(['field-input'])
    expect(FieldStyle.pieces.label).toBeUndefined()
  })

  it('forSlots rejects an unknown slot at runtime', () => {
    expect(() => Style.forSlots(FieldSlots)({ missing: Style.class('x') } as never)).toThrow(
      DiagnosticError,
    )
  })

  it('attach styles the view and renders into Foldkit markup', () => {
    const FieldStyle = Style.forSlots(FieldSlots)({
      root: Style.compose(Style.class('field'), Style.inline({ display: 'grid' })),
    })
    const html = FieldView.pipe(Style.attach(FieldStyle))({ label: 'Name' }, h)
    const data = vnodeData(html)
    expect(data.class).toMatchObject({ field: true })
    expect(data.style).toMatchObject({ display: 'grid' })
  })

  it('recipe applies base, selected variants, and defaults', () => {
    const Button = Style.recipe({
      base: Style.class('button'),
      variants: {
        intent: { primary: Style.class('primary'), secondary: Style.class('secondary') },
        size: { sm: Style.class('sm'), md: Style.class('md') },
      },
      defaults: { size: 'md' },
    })
    expect(Button({ intent: 'secondary' }).classes).toEqual(['button', 'secondary', 'md'])
    expect(Button({ intent: 'primary', size: 'sm' }).classes).toEqual(['button', 'primary', 'sm'])
  })
})
