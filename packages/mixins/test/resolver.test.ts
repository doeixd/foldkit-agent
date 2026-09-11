import { describe, expect, it } from 'vitest'
import { Attr, Event, Mixin, Resolver, Slot, type SlotAttributes } from '../src/index.js'
import { DiagnosticError } from '../src/diagnostics.js'
import { fakeChild, h, mount, type TestMessage } from './resolverFixture.js'

const tagOf = <Message>(attribute: SlotAttributes<Message>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

const tags = <Message>(attributes: SlotAttributes<Message>): ReadonlyArray<string> =>
  attributes.map(tagOf)

const attributeOf = <Message>(
  attributes: SlotAttributes<Message>,
  tag: string,
): { readonly value: unknown } | undefined => {
  for (const attribute of attributes) {
    if (tagOf(attribute) === tag) return attribute as { readonly value: unknown }
  }
  return undefined
}

const classOf = <Message>(attributes: SlotAttributes<Message>): unknown =>
  attributeOf(attributes, 'Class')?.value

const styleOf = <Message>(attributes: SlotAttributes<Message>): unknown =>
  attributeOf(attributes, 'Style')?.value

const mountNames = <Message>(attributes: SlotAttributes<Message>): ReadonlyArray<string> =>
  attributes
    .filter(attribute => tagOf(attribute) === 'OnMount')
    .map(attribute => (attribute as { readonly action: { readonly name: string } }).action.name)

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (error) {
    if (error instanceof DiagnosticError) return error.diagnostic.code
    throw error
  }
  throw new Error('expected resolve to throw')
}

describe('Resolver.resolve', () => {
  it('adds and deduplicates class tokens, emitting one Class', () => {
    const out = Resolver.resolve([h.Class('a b'), h.Class('b c')], [{ classes: ['c', 'd'] }])
    expect(classOf(out)).toBe('a b c d')
    expect(out.filter(attribute => tagOf(attribute) === 'Class')).toHaveLength(1)
  })

  it('merges inline style per property in attachment order, emitting one Style', () => {
    const out = Resolver.resolve(
      [h.Style({ color: 'red', padding: '1px' })],
      [{ style: { color: 'blue' } }, { style: { padding: '2px' } }],
    )
    expect(styleOf(out)).toEqual({ color: 'blue', padding: '2px' })
    expect(out.filter(attribute => tagOf(attribute) === 'Style')).toHaveLength(1)
  })

  it('lets a Mixin add an unowned scalar attribute', () => {
    const out = Resolver.resolve([h.Role('button')], [{ attributes: [h.AriaDisabled(true)] }])
    expect(tags(out)).toEqual(['Role', 'AriaDisabled'])
  })

  it('rejects a Mixin that replaces a base scalar attribute', () => {
    expect(
      codeOf(() => Resolver.resolve([h.Role('button')], [{ attributes: [h.Role('link')] }])),
    ).toBe('mixins:attribute-conflict')
  })

  it('rejects two owners of one semantic event', () => {
    expect(
      codeOf(() =>
        Resolver.resolve(
          [h.OnClick({ _tag: 'Clicked' })],
          [{ attributes: [h.OnClick({ _tag: 'Other' })] }],
        ),
      ),
    ).toBe('mixins:event-conflict')
  })

  it('treats distinct raw attribute keys as distinct owners', () => {
    const out = Resolver.resolve(
      [h.Attribute('data-a', '1')],
      [{ attributes: [h.Attribute('data-b', '2')] }],
    )
    expect(tags(out)).toEqual(['Attribute', 'Attribute'])
  })

  it('rejects a redundant raw attribute key', () => {
    expect(
      codeOf(() =>
        Resolver.resolve(
          [h.Attribute('data-a', '1')],
          [{ attributes: [h.Attribute('data-a', '2')] }],
        ),
      ),
    ).toBe('mixins:attribute-conflict')
  })

  it('refuses Key and InnerHTML from a Mixin', () => {
    expect(codeOf(() => Resolver.resolve([], [{ attributes: [h.Key('row')] }]))).toBe(
      'mixins:structural-override',
    )
    expect(codeOf(() => Resolver.resolve([], [{ attributes: [h.InnerHTML('<b>x</b>')] }]))).toBe(
      'mixins:structural-override',
    )
  })

  it('preserves a ChildAttribute by identity and reserves its event', () => {
    const child = fakeChild(h.OnClick({ _tag: 'Clicked' }))
    const out = Resolver.resolve([child], [])
    expect(out).toContain(child)
    expect(
      codeOf(() => Resolver.resolve([child], [{ attributes: [h.OnClick({ _tag: 'Other' })] }])),
    ).toBe('mixins:event-conflict')
  })

  it('composes every Mount into exactly one OnMount', () => {
    const out = Resolver.resolve([h.OnMount(mount('A'))], [{ mounts: [mount('B'), mount('C')] }])
    expect(mountNames(out)).toEqual(['Mixins[slot](A,B,C)'])
  })

  it('rejects two Mounts with one name', () => {
    expect(
      codeOf(() => Resolver.resolve([h.OnMount(mount('A'))], [{ mounts: [mount('A')] }])),
    ).toBe('mixins:duplicate-mount-name')
  })

  it('honors protected events, attributes, and style properties', () => {
    const protection = Slot.make({
      protected: { events: [Event.Click], attributes: [Attr.Role], style: ['position'] },
    }).protected
    const options = { slot: 'root', protected: protection }
    expect(
      codeOf(() =>
        Resolver.resolve([], [{ attributes: [h.OnClick({ _tag: 'Clicked' })] }], options),
      ),
    ).toBe('mixins:protected-event')
    expect(codeOf(() => Resolver.resolve([], [{ attributes: [h.Role('button')] }], options))).toBe(
      'mixins:protected-attribute',
    )
    expect(codeOf(() => Resolver.resolve([], [{ style: { position: 'absolute' } }], options))).toBe(
      'mixins:protected-style-property',
    )
  })

  it('is deterministic for the same inputs', () => {
    const build = (): ReadonlyArray<string> =>
      tags(
        Resolver.resolve(
          [h.Class('a'), h.Role('button'), h.OnClick({ _tag: 'Clicked' })],
          [{ classes: ['b'], style: { color: 'red' } }],
        ),
      )
    expect(build()).toEqual(build())
  })
})

describe('Resolver.resolveSlot', () => {
  it('folds a Mixin contribution for one slot', () => {
    const Decoration = Mixin.make('Decoration', {
      root: { classes: ['decorated'] },
      label: { classes: ['labelled'] },
    })
    expect(classOf(Resolver.resolveSlot([], [Decoration], 'root'))).toBe('decorated')
    expect(classOf(Resolver.resolveSlot([], [Decoration], 'label'))).toBe('labelled')
    expect(tags(Resolver.resolveSlot([], [Decoration], 'input'))).toEqual([])
  })
})
