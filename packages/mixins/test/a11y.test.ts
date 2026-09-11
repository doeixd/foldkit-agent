import { describe, expect, it } from 'vitest'
import { A11y, Attr, Capability, Event, Slot, Slots, type A11yDiagnostic } from '../src/index.js'
import { FieldSlots } from './fixture.js'

const codes = (diagnostics: ReadonlyArray<A11yDiagnostic>): ReadonlyArray<string> =>
  diagnostics.map(diagnostic => diagnostic.code)

describe('A11y', () => {
  const FieldPattern = A11y.pattern({
    root: { capability: Capability.Container },
    input: {
      capability: Capability.TextInput,
      events: [Event.Input, Event.Focus],
      attributes: [Attr.AriaLabel],
    },
  })

  it('accepts a contract that satisfies the pattern', () => {
    expect(A11y.validate(FieldPattern, FieldSlots)).toEqual([])
  })

  it('accepts a capability satisfied through inheritance', () => {
    const pattern = A11y.pattern({ input: { capability: Capability.Interactive } })
    expect(A11y.validate(pattern, FieldSlots)).toEqual([])
  })

  it('matches a required token by name against a published string', () => {
    const pattern = A11y.pattern({ input: { events: ['input'], attributes: ['aria-label'] } })
    expect(A11y.validate(pattern, FieldSlots)).toEqual([])
  })

  it('reports a missing slot', () => {
    const pattern = A11y.pattern({ legend: { capability: Capability.Container } })
    const diagnostics = A11y.validate(pattern, FieldSlots)
    expect(codes(diagnostics)).toEqual(['a11y:missing-slot'])
    expect(diagnostics[0]).toMatchObject({ source: 'a11y', severity: 'error', slot: 'legend' })
  })

  it('does not report an optional missing slot', () => {
    const pattern = A11y.pattern({ legend: { capability: Capability.Container, optional: true } })
    expect(A11y.validate(pattern, FieldSlots)).toEqual([])
  })

  it('still checks a present optional slot', () => {
    const pattern = A11y.pattern({ root: { capability: Capability.TextInput, optional: true } })
    expect(codes(A11y.validate(pattern, FieldSlots))).toEqual(['a11y:capability-mismatch'])
  })

  it('reports a hidden slot and stops checking it', () => {
    const pattern = A11y.pattern({
      internals: { capability: Capability.TextInput, events: [Event.Click] },
    })
    expect(codes(A11y.validate(pattern, FieldSlots))).toEqual(['a11y:hidden-slot'])
  })

  it('reports a capability mismatch with both names', () => {
    const pattern = A11y.pattern({ root: { capability: Capability.TextInput } })
    const diagnostics = A11y.validate(pattern, FieldSlots)
    expect(codes(diagnostics)).toEqual(['a11y:capability-mismatch'])
    expect(diagnostics[0]?.details).toEqual({ required: 'TextInput', actual: 'Container' })
  })

  it('reports a missing event', () => {
    const pattern = A11y.pattern({ root: { events: [Event.Click] } })
    expect(codes(A11y.validate(pattern, FieldSlots))).toEqual(['a11y:missing-event'])
  })

  it('reports a missing attribute', () => {
    const pattern = A11y.pattern({ root: { attributes: [Attr.Role] } })
    expect(codes(A11y.validate(pattern, FieldSlots))).toEqual(['a11y:missing-attribute'])
  })

  it('reports every mismatch in authored order', () => {
    const pattern = A11y.pattern({
      legend: {},
      root: {
        capability: Capability.TextInput,
        events: [Event.Input],
        attributes: [Attr.Role],
      },
    })
    expect(codes(A11y.validate(pattern, FieldSlots))).toEqual([
      'a11y:missing-slot',
      'a11y:capability-mismatch',
      'a11y:missing-event',
      'a11y:missing-attribute',
    ])
  })

  it('does not treat an inherited key as a published slot', () => {
    const plain = { ...FieldSlots }
    const pattern = A11y.pattern({ toString: {} })
    expect(codes(A11y.validate(pattern, plain))).toEqual(['a11y:missing-slot'])
  })

  it('supports __proto__ as a slot name', () => {
    const contract = Slots.define({
      ['__proto__']: Slot.make({ capability: Capability.Container }),
    })
    const pattern = A11y.pattern({ ['__proto__']: { capability: Capability.Container } })
    expect(A11y.validate(pattern, contract)).toEqual([])
  })
})
