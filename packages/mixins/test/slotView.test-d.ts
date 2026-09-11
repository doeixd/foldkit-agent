/**
 * Compile-time SlotView contract. Type-checked, not executed.
 */
import type { HtmlBuilder } from 'foldkit/html'
import { Mixin, SlotView } from '../src/index.js'
import { FieldSlots } from './fixture.js'
import { h, type TestMessage } from './resolverFixture.js'

interface FieldInput {
  readonly label: string
}

const FieldView = SlotView.define(
  FieldSlots,
  (input: FieldInput, slots, h: HtmlBuilder<TestMessage>) =>
    h.div(slots.root.attrs([h.Value(input.label)])),
)

// @ts-expect-error unknown slot key.
const _missing = FieldView.slots.missing
void _missing

// @ts-expect-error the render input must match.
FieldView({ wrong: true }, h)

const Decoration = Mixin.make<TestMessage>('Decoration', { root: { classes: ['x'] } })
const _attached = FieldView.pipe(SlotView.attach(Decoration))
void _attached

// @ts-expect-error the render input must still match after attach.
_attached({ wrong: true }, h)

// @ts-expect-error a foreign Message universe cannot attach.
FieldView.pipe(SlotView.attach(Mixin.make<{ readonly _tag: 'Foreign' }>('Foreign', {})))
