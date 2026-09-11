import { describe, expect, it } from 'vitest'
import { Attr, Capability, Event, Requirement, Slot, Slots } from '../src/index.js'
import { FieldSlots } from './fixture.js'

describe('Slot and Slots', () => {
  it('takes slot names from object keys', () => {
    expect(Slot.is(FieldSlots.input)).toBe(true)
    expect(FieldSlots.root.name).toBe('root')
    expect(FieldSlots.label.name).toBe('label')
    expect(FieldSlots.input.name).toBe('input')
    expect(FieldSlots.input.capability).toBe(Capability.TextInput)
    expect(FieldSlots.input.events.map(event => event.name)).toEqual(['input', 'focus', 'blur'])
    expect(FieldSlots.input.attributes.map(attr => attr.name)).toEqual([
      'aria-label',
      'aria-invalid',
    ])
  })

  it('keeps hidden slots represented', () => {
    expect(FieldSlots.internals.hidden).toBe(true)
    expect(FieldSlots.input.hidden).toBe(false)
  })

  it('describe is JSON-serializable and has no functions', () => {
    const described = Slots.describe(FieldSlots)
    const parsed = JSON.parse(JSON.stringify(described)) as typeof described
    expect(parsed.slots.input).toEqual({
      name: 'input',
      capability: 'TextInput',
      events: ['input', 'focus', 'blur'],
      attributes: ['aria-label', 'aria-invalid'],
      requirements: [],
      hidden: false,
      protected: { events: [], attributes: [], style: [] },
    })
    expect(parsed.slots.internals?.hidden).toBe(true)
  })

  it('stores a quoted __proto__ slot name as an own property', () => {
    const slots = Slots.define({
      ['__proto__']: Slot.make({ capability: Capability.Base }),
    })
    expect(Object.prototype.hasOwnProperty.call(slots, '__proto__')).toBe(true)
    expect(slots['__proto__']?.name).toBe('__proto__')
    expect(Object.getPrototypeOf(slots)).toBe(null)
  })

  it('rejects a non-plain spec object', () => {
    const proto = { leaked: Slot.make({ capability: Capability.Base }) }
    expect(() => Slots.define(Object.create(proto))).toThrow(/plain object/)
  })

  it('rejects a spec value that is not a Slot or options object', () => {
    expect(() =>
      Slots.define({
        root: Capability.Base,
      } as never),
    ).toThrow(/not a Slot/)
  })

  it('does not treat an inherited capability as slot options', () => {
    const inherited = Object.create({ capability: Capability.Base })
    expect(() => Slots.define({ root: inherited } as never)).toThrow(/not a Slot/)
  })

  it('filters slots by capability the way AF-UI withCapability does', () => {
    const textInputs = Slots.withCapability(FieldSlots, Capability.TextInput)
    expect(Object.getOwnPropertyNames(textInputs)).toEqual(['input'])
    expect(textInputs.input?.name).toBe('input')
  })

  it('records protected events, attributes, and style properties', () => {
    const slot = Slot.make({
      capability: Capability.Container,
      protected: {
        events: [Event.Click],
        attributes: [Attr.Role],
        style: ['position'],
      },
    })
    expect(Slot.describe(slot).protected).toEqual({
      events: ['click'],
      attributes: ['role'],
      style: ['position'],
    })
  })

  it('slot transforms replace one facet and preserve the rest', () => {
    const base = FieldSlots.input
    const retargeted = Slot.capability(Capability.Interactive)(base)
    expect(retargeted.capability).toBe(Capability.Interactive)
    expect(retargeted.events).toBe(base.events)

    const clickable = Slot.events(Event.Click)(base)
    expect(clickable.events.map(event => event.name)).toEqual(['click'])
    expect(clickable.capability).toBe(base.capability)

    const attributed = Slot.attributes(Attr.Role)(base)
    expect(attributed.attributes.map(attr => attr.name)).toEqual(['role'])

    const required = Slot.requires(Requirement.Keyboard)(base)
    expect(required.requirements.map(requirement => requirement.name)).toEqual(['keyboard'])

    expect(Slot.hide(base).hidden).toBe(true)
  })

  it('pipe threads transforms and changes the type', () => {
    const clickable = FieldSlots.root.pipe(
      Slot.events(Event.Click),
      Slot.capability(Capability.Interactive),
    )
    expect(Slot.describe(clickable)).toMatchObject({
      name: 'root',
      capability: 'Interactive',
      events: ['click'],
    })
  })
})
