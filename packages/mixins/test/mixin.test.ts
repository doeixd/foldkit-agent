import { describe, expect, it } from 'vitest'
import { Mixin } from '../src/index.js'
import { h, mount, type TestMessage } from './resolverFixture.js'

describe('Mixin.compose', () => {
  it('merges per-slot contributions in order', () => {
    const a = Mixin.make<TestMessage>('A', {
      root: {
        classes: ['a'],
        style: { color: 'red' },
        attributes: [h.Role('button')],
      },
    })
    const b = Mixin.make<TestMessage>('B', {
      root: {
        classes: ['b'],
        style: { color: 'blue', padding: '1px' },
        attributes: [h.AriaDisabled(true)],
        mounts: [mount('M')],
      },
    })
    const merged = Mixin.compose(a, b)
    const root = Mixin.evaluate(merged.contributions.root ?? {}, { input: undefined, h })
    expect(merged.name).toBe('A+B')
    expect(root.classes).toEqual(['a', 'b'])
    expect(root.style).toEqual({ color: 'blue', padding: '1px' })
    expect(root.attributes).toHaveLength(2)
    expect(root.mounts).toHaveLength(1)
  })

  it('is immutable and leaves inputs untouched', () => {
    const a = Mixin.make<TestMessage>('A', { root: { classes: ['a'] } })
    const b = Mixin.make<TestMessage>('B', { root: { classes: ['b'] } })
    const merged = Mixin.compose(a, b)
    expect(a.contributions.root?.classes).toEqual(['a'])
    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged.contributions.root)).toBe(true)
  })

  it('composes nothing into Empty', () => {
    const empty = Mixin.compose<TestMessage>()
    expect(empty.name).toBe('Empty')
    expect(Object.keys(empty.contributions)).toEqual([])
    expect(Mixin.empty<TestMessage>().name).toBe('Empty')
  })

  it('composes a message-free Mixin with a message-bearing one', () => {
    const style = Mixin.dynamic<never>('Style', { root: { classes: ['s'] } })
    const behavior = Mixin.make<TestMessage>('B', {
      root: { attributes: [h.OnClick({ _tag: 'Clicked' })] },
    })
    const merged = Mixin.compose(style, behavior)
    const root = Mixin.evaluate(merged.contributions.root ?? {}, { input: undefined, h })
    expect(merged.name).toBe('Style+B')
    expect(root.classes).toEqual(['s'])
    expect(root.attributes).toHaveLength(1)
  })
})
