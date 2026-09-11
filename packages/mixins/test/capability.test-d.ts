/**
 * Compile-time capability inheritance. This file is type-checked, not executed.
 */
import { Capability, type Satisfies } from '../src/index.js'

const _textInputIsInteractive: Satisfies<
  typeof Capability.TextInput,
  typeof Capability.Interactive
> = true

const _textInputIsBase: Satisfies<typeof Capability.TextInput, typeof Capability.Base> = true

const _containerIsInteractive: Satisfies<
  typeof Capability.Container,
  typeof Capability.Interactive
> = true

const _selectTrigger = Capability.make('TypeSelectTrigger', {
  extends: [Capability.Focusable],
})
const _customIsFocusable: Satisfies<typeof _selectTrigger, typeof Capability.Focusable> = true

// @ts-expect-error Container does not satisfy TextInput.
const _containerIsTextInput: Satisfies<typeof Capability.Container, typeof Capability.TextInput> =
  true

// @ts-expect-error Base does not satisfy Interactive.
const _baseIsInteractive: Satisfies<typeof Capability.Base, typeof Capability.Interactive> = true

// @ts-expect-error Collection does not satisfy Focusable.
const _collectionIsFocusable: Satisfies<typeof Capability.Collection, typeof Capability.Focusable> =
  true

void _textInputIsInteractive
void _textInputIsBase
void _containerIsInteractive
void _customIsFocusable
void _containerIsTextInput
void _baseIsInteractive
void _collectionIsFocusable
