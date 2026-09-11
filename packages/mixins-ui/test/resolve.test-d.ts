/**
 * Compile-time adapter contract. Type-checked, not executed.
 */
import { Behavior, type SlotAttributes } from 'foldkit-mixins'
import { ButtonSlots, resolve } from '../src/index.js'
import { h, type TestMessage } from './fixture.js'

const resolved = resolve(ButtonSlots, [], { input: undefined, h })
const _button: SlotAttributes<TestMessage> = resolved({ button: [] }).button
void _button

type ForeignMessage = { readonly _tag: 'Foreign' }
const Foreign = Behavior.forSlots(ButtonSlots)<undefined, ForeignMessage>({
  button: Behavior.slot({ attributes: () => [] }),
})

// @ts-expect-error a Behavior from another Message universe cannot attach here.
resolve(ButtonSlots, [Foreign.mixin], { input: undefined, h })

// @ts-expect-error a base bundle must use the component's published slot keys.
resolve(ButtonSlots, [], { input: undefined, h })({ missing: [] })
