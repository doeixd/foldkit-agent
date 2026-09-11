/**
 * Compile-time A11y contract. Type-checked, not executed.
 */
import {
  A11y,
  Attr,
  Capability,
  Event,
  type A11yDiagnostic,
  type A11yDiagnosticCode,
} from '../src/index.js'
import { FieldSlots } from './fixture.js'

const FieldPattern = A11y.pattern({
  root: { capability: Capability.Container },
  input: {
    capability: Capability.TextInput,
    events: [Event.Input, Event.Focus],
    attributes: [Attr.AriaLabel],
  },
})

const _diagnostics: ReadonlyArray<A11yDiagnostic> = A11y.validate(FieldPattern, FieldSlots)
const _code: A11yDiagnosticCode = _diagnostics[0]!.code
void _diagnostics
void _code

// A pattern is a portable contract: keys are not constrained to one slot set.
// A missing slot is a runtime diagnostic, not a compile error.
A11y.validate(A11y.pattern({ legend: {} }), FieldSlots)

// @ts-expect-error a requirement has no `event` field.
A11y.pattern({ trigger: { event: Event.Click } })

// @ts-expect-error a11y diagnostics never carry a mixins code.
const _mixinsCode: A11yDiagnosticCode = 'mixins:unknown-slot'
void _mixinsCode

// @ts-expect-error only A11y.pattern produces a branded pattern.
A11y.validate({ requirements: {} }, FieldSlots)
