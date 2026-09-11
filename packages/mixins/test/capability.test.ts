import { describe, expect, it } from 'vitest'
import { Capability } from '../src/index.js'

describe('Capability', () => {
  it.each([
    ['TextInput', Capability.TextInput, Capability.TextInput],
    ['Focusable', Capability.TextInput, Capability.Focusable],
    ['Interactive', Capability.TextInput, Capability.Interactive],
    ['Base', Capability.TextInput, Capability.Base],
    ['Container is Interactive', Capability.Container, Capability.Interactive],
    ['Collection is Base', Capability.Collection, Capability.Base],
  ] as const)('%s satisfies', (_label, actual, required) => {
    expect(Capability.satisfies(actual, required)).toBe(true)
  })

  it.each([
    ['Container is not TextInput', Capability.Container, Capability.TextInput],
    ['Base is not Interactive', Capability.Base, Capability.Interactive],
    ['Draggable is not Focusable', Capability.Draggable, Capability.Focusable],
    ['Collection is not Interactive', Capability.Collection, Capability.Interactive],
  ] as const)('%s', (_label, actual, required) => {
    expect(Capability.satisfies(actual, required)).toBe(false)
  })

  it('custom capabilities inherit the declared parents', () => {
    const SelectTrigger = Capability.make('SelectTrigger', {
      extends: [Capability.Focusable],
    })
    expect(Capability.satisfies(SelectTrigger, Capability.Focusable)).toBe(true)
    expect(Capability.satisfies(SelectTrigger, Capability.Interactive)).toBe(true)
    expect(Capability.satisfies(SelectTrigger, Capability.TextInput)).toBe(false)
    expect(Capability.describe(SelectTrigger)).toEqual({
      name: 'SelectTrigger',
      extends: ['Focusable'],
    })
  })

  it('stores __proto__ as a custom name without losing the registry entry', () => {
    const weird = Capability.make('__proto__', { extends: [Capability.Base] })
    expect(weird.name).toBe('__proto__')
    expect(Capability.satisfies(weird, Capability.Base)).toBe(true)
    expect(Capability.make('__proto__', { extends: [Capability.Base] })).toBe(weird)
  })

  it('rejects a second make of the same name with different parents', () => {
    Capability.make('Once', { extends: [Capability.Base] })
    expect(() => Capability.make('Once', { extends: [Capability.Interactive] })).toThrow(
      /already defined/,
    )
  })

  it('rejects an empty name', () => {
    expect(() => Capability.make('')).toThrow(/non-empty/)
  })

  it('describe is JSON-serializable', () => {
    const json = JSON.stringify(Capability.describe(Capability.TextInput))
    expect(JSON.parse(json)).toEqual({ name: 'TextInput', extends: ['Focusable'] })
  })

  it('names walks ancestors once and includes self', () => {
    expect(Capability.names(Capability.TextInput)).toEqual([
      'TextInput',
      'Focusable',
      'Interactive',
      'Base',
    ])
  })
})
