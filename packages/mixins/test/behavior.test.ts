import { describe, expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import {
  Attr,
  Behavior,
  Capability,
  Event,
  Mixin,
  SlotView,
  Style,
  type ContributionContext,
  type SlotAttributes,
} from '../src/index.js'
import { DiagnosticError } from '../src/diagnostics.js'
import { FieldSlots } from './fixture.js'
import { h, type TestMessage } from './resolverFixture.js'

interface FieldInput {
  readonly invalid: boolean
}

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (error) {
    if (error instanceof DiagnosticError) return error.diagnostic.code
    throw error
  }
  throw new Error('expected to throw')
}

const tagOf = (attribute: SlotAttributes<TestMessage>[number]): string =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String((attribute as { readonly _tag: unknown })._tag)
    : 'Child'

const Validation = Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>(
  {
    input: Behavior.slot({
      requires: { capability: Capability.TextInput, attributes: [Attr.AriaInvalid] },
      attributes: ({
        input,
        h,
      }: {
        readonly input: FieldInput
        readonly h: HtmlBuilder<TestMessage>
      }) => [h.AriaInvalid(input.invalid)],
    }),
  },
  { name: 'Validation' },
)

const context = (invalid: boolean): ContributionContext<TestMessage> => ({
  input: { invalid },
  h,
})

describe('Behavior', () => {
  it('builds attributes from the view input and h', () => {
    const builders = SlotView.buildersFor(FieldSlots, [Validation.mixin], context(true))
    const aria = builders.input.attrs().find(attribute => tagOf(attribute) === 'AriaInvalid')
    expect(aria).toMatchObject({ value: true })
    expect(builders.label.attrs()).toEqual([])
  })

  it('contributes nothing for a slot with no attributes or mount', () => {
    const Noop = Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
      root: Behavior.slot({ requires: { capability: Capability.Container } }),
    })
    expect(Noop.mixin.contributions.root).toBeUndefined()
  })

  it('composes with a Style on the same view', () => {
    const FieldStyle = Style.forSlots(FieldSlots)({ input: Style.class('field-input') })
    const builders = SlotView.buildersFor(
      FieldSlots,
      [FieldStyle.mixin, Validation.mixin],
      context(false),
    )
    const attributes = builders.input.attrs()
    expect(attributes.map(tagOf)).toContain('Class')
    expect(attributes.some(attribute => tagOf(attribute) === 'AriaInvalid')).toBe(true)
  })

  it('attaches to a SlotView and renders through the view h', () => {
    const View = SlotView.define(
      FieldSlots,
      (_input: FieldInput, slots, h: HtmlBuilder<TestMessage>) => h.input(slots.input.attrs()),
    ).pipe(Behavior.attach(Validation))
    expect(View({ invalid: true }, h)).toBeDefined()
  })

  it('rejects an unknown slot', () => {
    expect(
      codeOf(() =>
        Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
          missing: Behavior.slot({}),
        } as never),
      ),
    ).toBe('mixins:unknown-slot')
  })

  it('rejects a capability the slot does not satisfy', () => {
    expect(
      codeOf(() =>
        Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
          root: Behavior.slot({ requires: { capability: Capability.TextInput } }),
        }),
      ),
    ).toBe('mixins:capability-mismatch')
  })

  it('rejects an event the slot does not publish', () => {
    expect(
      codeOf(() =>
        Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
          input: Behavior.slot({ requires: { events: [Event.Click] } }),
        }),
      ),
    ).toBe('mixins:unsupported-event')
  })

  it('rejects an attribute the slot does not publish', () => {
    expect(
      codeOf(() =>
        Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
          input: Behavior.slot({ requires: { attributes: [Attr.Role] } }),
        }),
      ),
    ).toBe('mixins:unsupported-attribute')
  })

  it('composes deferred contributions without evaluating them', () => {
    const merged = Mixin.compose(Validation.mixin)
    const contribution = merged.contributions.input
    expect(typeof contribution).toBe('function')
  })
})
