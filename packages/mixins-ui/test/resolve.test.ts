import { describe, expect, it } from 'vitest'
import {
  Behavior,
  Capability,
  Diagnostics,
  Event,
  Slot,
  Slots,
  Style,
  type SlotAttributes,
} from 'foldkit-mixins'
import { resolve as resolveUi } from '../src/index.js'
import { attributeOf, fakeChild, h, message, tagsOf, type TestMessage } from './fixture.js'

const RootSlots = Slots.define({
  root: Slot.make({ capability: Capability.Container, events: [Event.Click] }),
})

describe('resolveFor', () => {
  it('keeps a ChildAttribute by identity and surrounds it with Mixin output', () => {
    const child = fakeChild(h.OnClick(message('Clicked')))
    const PanelStyle = Style.forSlots(RootSlots)({ root: Style.class('panel') })
    const resolved = resolveUi(RootSlots, [PanelStyle.mixin], { input: undefined, h })({
      root: [h.Role('region'), child],
    })
    expect(resolved.root).toContain(child)
    expect(tagsOf(resolved.root)).toContain('Role')
    expect(attributeOf(resolved.root, 'Class')?.value).toBe('panel')
  })

  it('rejects a Behavior that claims an event the base already owns', () => {
    const Steal = Behavior.forSlots(RootSlots)<undefined, TestMessage>({
      root: Behavior.slot({ attributes: () => [h.OnClick(message('Other'))] }),
    })
    expect(() =>
      resolveUi(RootSlots, [Steal.mixin], { input: undefined, h })({
        root: [h.OnClick(message('Clicked'))],
      }),
    ).toThrow(Diagnostics.DiagnosticError)
  })

  it('leaves slots with no contribution untouched', () => {
    const base: ReadonlyArray<SlotAttributes<TestMessage>[number]> = [h.Role('region')]
    const resolved = resolveUi(RootSlots, [], { input: undefined, h })({ root: base })
    expect(resolved.root).toEqual(base)
  })
})
