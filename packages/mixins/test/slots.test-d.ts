/**
 * Compile-time slot contracts. This file is type-checked, not executed.
 */
import { Capability, Event, Slot, Slots } from '../src/index.js'
import type { EventsOf } from '../src/slot.js'
import type { NamesOf, PublicNamesOf } from '../src/slots.js'
import { FieldSlots } from './fixture.js'

const _inputName: 'input' = FieldSlots.input.name
const _inputCapability: typeof Capability.TextInput = FieldSlots.input.capability
const _inputEvents: readonly [typeof Event.Input, typeof Event.Focus, typeof Event.Blur] =
  FieldSlots.input.events

const _names: NamesOf<typeof FieldSlots> = 'input'
const _public: PublicNamesOf<typeof FieldSlots> = 'root'
const _inputEvent: EventsOf<(typeof FieldSlots)['input']> = 'input'

const _clickable = Slot.events(Event.Click)(FieldSlots.root)
const _clickableEvents: readonly [typeof Event.Click] = _clickable.events

// `pipe` accepts a type-changing transform. Its inferred `Next` widens through
// the higher-order match, so the runtime test asserts the value, not this.
const _piped = FieldSlots.root.pipe(Slot.events(Event.Click))
void _piped

void _inputName
void _inputCapability
void _inputEvents
void _names
void _public
void _inputEvent
void _clickable
void _clickableEvents

// @ts-expect-error internals is hidden
const _hiddenAsPublic: PublicNamesOf<typeof FieldSlots> = 'internals'
void _hiddenAsPublic

// @ts-expect-error click is not an allowed event on input
const _badEvent: EventsOf<(typeof FieldSlots)['input']> = 'click'
void _badEvent

// @ts-expect-error unknown slot key.
const _missing: keyof typeof FieldSlots = 'missing'
void _missing

// @ts-expect-error unknown field on Slot.make.
Slot.make({
  capability: Capability.Container,
  notAField: true,
})

Slots.define({
  root: Slot.make({
    capability: Capability.Container,
  }),
  // @ts-expect-error values must be Slots or slot options.
  bad: 42,
})
