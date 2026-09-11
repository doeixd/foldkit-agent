/**
 * Structural accessibility validation. A `Pattern` names the Slots a widget
 * must publish, the capabilities those Slots must satisfy, and the events and
 * attributes they must expose. `validate` compares a `Slots` contract against a
 * pattern and reports every mismatch as a `Diagnostic`. It is pure and
 * DOM-independent: it checks the declared contract, not a rendered tree, so it
 * verifies only the contract it is given and does not certify WCAG conformance.
 */
import * as Capability from './capability.js'
import type { Diagnostic } from './diagnostics.js'
import * as MetadataToken from './metadataToken.js'
import type { Any as AnySlot, AttributeName, EventName, SlotCapability } from './slot.js'

export type A11yDiagnosticCode =
  | 'a11y:missing-slot'
  | 'a11y:hidden-slot'
  | 'a11y:capability-mismatch'
  | 'a11y:missing-event'
  | 'a11y:missing-attribute'

export interface A11yDiagnostic extends Diagnostic {
  readonly source: 'a11y'
  readonly code: A11yDiagnosticCode
}

export interface SlotRequirement {
  readonly capability?: SlotCapability
  readonly events?: ReadonlyArray<EventName>
  readonly attributes?: ReadonlyArray<AttributeName>
  /** An absent slot is expected, not a diagnostic. A present slot is still checked. */
  readonly optional?: boolean
}

export type Requirements = Readonly<Record<string, SlotRequirement>>

export const PatternTypeId: unique symbol = Symbol.for('foldkit-mixins/A11yPattern')

export interface Pattern<Spec extends Requirements = Requirements> {
  readonly [PatternTypeId]: { readonly Requirements: Spec }
  readonly requirements: Spec
}

export const pattern = <const Spec extends Requirements>(spec: Spec): Pattern<Spec> => {
  const requirements = Object.create(null) as Record<string, SlotRequirement>
  for (const name of Object.getOwnPropertyNames(spec)) {
    const requirement = spec[name]
    if (requirement === undefined) continue
    Object.defineProperty(requirements, name, {
      value: Object.freeze({ ...requirement }),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  Object.freeze(requirements)
  return Object.freeze({
    [PatternTypeId]: { Requirements: undefined as unknown as Spec },
    requirements: requirements as Spec,
  }) as Pattern<Spec>
}

const publishes = (
  names: ReadonlyArray<string | MetadataToken.Any>,
  required: string | MetadataToken.Any,
): boolean => {
  const requiredName = MetadataToken.nameOf(required)
  return names.some(name => MetadataToken.nameOf(name) === requiredName)
}

const diagnostic = (
  code: A11yDiagnosticCode,
  message: string,
  slot: string,
  details?: Readonly<Record<string, unknown>>,
): A11yDiagnostic => ({
  source: 'a11y',
  code,
  severity: 'error',
  message,
  slot,
  ...(details === undefined ? {} : { details }),
})

export const validate = (
  pattern: Pattern,
  slots: { readonly [name: string]: AnySlot },
): ReadonlyArray<A11yDiagnostic> => {
  const diagnostics: Array<A11yDiagnostic> = []
  for (const name of Object.getOwnPropertyNames(pattern.requirements)) {
    const requirement = pattern.requirements[name]
    if (requirement === undefined) continue
    if (!Object.hasOwn(slots, name)) {
      if (requirement.optional === true) continue
      diagnostics.push(
        diagnostic(
          'a11y:missing-slot',
          `A11y pattern requires slot "${name}", which the contract does not publish`,
          name,
        ),
      )
      continue
    }
    const slot = slots[name]
    if (slot === undefined) continue
    if (slot.hidden) {
      diagnostics.push(
        diagnostic(
          'a11y:hidden-slot',
          `A11y pattern requires slot "${name}", which is hidden`,
          name,
        ),
      )
      continue
    }
    if (
      requirement.capability !== undefined &&
      !Capability.extendsCapability(slot.capability, requirement.capability)
    ) {
      diagnostics.push(
        diagnostic(
          'a11y:capability-mismatch',
          `A11y pattern requires capability "${MetadataToken.nameOf(requirement.capability)}" on slot "${name}", which has "${MetadataToken.nameOf(slot.capability)}"`,
          name,
          {
            required: MetadataToken.nameOf(requirement.capability),
            actual: MetadataToken.nameOf(slot.capability),
          },
        ),
      )
    }
    for (const event of requirement.events ?? []) {
      const eventName = MetadataToken.nameOf(event)
      if (publishes(slot.events, event)) continue
      diagnostics.push(
        diagnostic(
          'a11y:missing-event',
          `A11y pattern requires event "${eventName}" on slot "${name}", which does not publish it`,
          name,
          { event: eventName },
        ),
      )
    }
    for (const attribute of requirement.attributes ?? []) {
      const attributeName = MetadataToken.nameOf(attribute)
      if (publishes(slot.attributes, attribute)) continue
      diagnostics.push(
        diagnostic(
          'a11y:missing-attribute',
          `A11y pattern requires attribute "${attributeName}" on slot "${name}", which does not publish it`,
          name,
          { attribute: attributeName },
        ),
      )
    }
  }
  return diagnostics
}
