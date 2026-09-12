/**
 * Compile-time Behavior contract. Type-checked, not executed.
 */
import type { HtmlBuilder } from 'foldkit/html'
import { Behavior } from '../src/index.js'
import { FieldSlots } from './fixture.js'
import type { TestMessage } from './resolverFixture.js'

interface FieldInput {
  readonly invalid: boolean
}

// `input` and `h` are contextually typed from the explicit forSlots generics.
const _validation = Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
  input: Behavior.slot({
    attributes: ({ input, h }) => [h.AriaInvalid(input.invalid)],
  }),
})
void _validation

Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
  // @ts-expect-error unknown slot key.
  missing: Behavior.slot({}),
})

Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
  // @ts-expect-error a hidden slot is internal, not publicly targetable.
  internals: Behavior.slot({}),
})

Behavior.forSlots(FieldSlots)<FieldInput, TestMessage>({
  input: Behavior.slot({
    // @ts-expect-error unknown requires field.
    requires: { cap: 'x' },
  }),
})
