/**
 * `foldkit-mixins` — typed slot contracts and inside-out Style/Behavior
 * attachments for Foldkit.
 *
 * Phase 1 is the AF-UI slot contract port: MetadataToken, Capability, Event,
 * Attr, Requirement, Slot, Slots. No Handles, no Atoms. Resolver, SlotView,
 * Style, and Behavior land in later phases.
 */
export * as Attr from './attr.js'
export * as Capability from './capability.js'
export * as Event from './event.js'
export * as MetadataToken from './metadataToken.js'
export * as Requirement from './requirement.js'
export * as Slot from './slot.js'
export * as Slots from './slots.js'

export type { AttrToken } from './attr.js'
export type { Any as AnyCapability, Satisfies } from './capability.js'
export type { EventToken } from './event.js'
export type { RequirementToken } from './requirement.js'
export type { SlotProtection, UnnamedSlot } from './slot.js'
export type { Contract as SlotsContract } from './slots.js'
