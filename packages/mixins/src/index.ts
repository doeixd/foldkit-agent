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
export * as Diagnostics from './diagnostics.js'
export * as Event from './event.js'
export * as MetadataToken from './metadataToken.js'
export * as Mixin from './mixin.js'
export * as Requirement from './requirement.js'
export * as Resolver from './resolver.js'
export * as Slot from './slot.js'
export * as Slots from './slots.js'
export * as SlotView from './slotView.js'

export { Style } from './style.js'

export type { AttrToken } from './attr.js'
export type { Any as AnyCapability, Satisfies } from './capability.js'
export type { Contribution, SlotContribution } from './contribution.js'
export type { Diagnostic, DiagnosticCode } from './diagnostics.js'
export type { EventToken } from './event.js'
export type { RequirementToken } from './requirement.js'
export type { ResolveOptions, SlotAttributes } from './resolver.js'
export type { SlotProtection, UnnamedSlot } from './slot.js'
export type { SlotBuilder, SlotBuilders, SlotViewRender } from './slotView.js'
export type { Contract as SlotsContract } from './slots.js'
export type { NamedStyle, StylePieces, StyleValue } from './style.js'
