/**
 * `foldkit-mixins` — typed slot contracts and inside-out Style/Behavior
 * attachments for Foldkit.
 *
 * A view publishes `Slots`; `Style` and `Behavior` attach to those slots and
 * resolve into ordinary Foldkit attributes. No Handles, no Atoms, no second
 * runtime: state stays in Model/Submodel, effects in Command/Mount.
 */
export * as A11y from './a11y.js'
export * as Attr from './attr.js'
export * as Behavior from './behavior.js'
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
export { Theme } from './theme.js'

export type { AttrToken } from './attr.js'
export type {
  A11yDiagnostic,
  A11yDiagnosticCode,
  Pattern as A11yPattern,
  SlotRequirement as A11yRequirement,
} from './a11y.js'
export type {
  BehaviorSlotOptions,
  BehaviorSpec,
  NamedBehavior,
  SlotRequirements,
} from './behavior.js'
export type { Any as AnyCapability, Satisfies } from './capability.js'
export type {
  Contribution,
  ContributionContext,
  DynamicContribution,
  InputContribution,
  SlotContribution,
  StaticContribution,
  StaticContributionMap,
} from './contribution.js'
export type { Diagnostic, DiagnosticCode } from './diagnostics.js'
export type { EventToken } from './event.js'
export type { AnyMixin, Mixin as MixinValue, MixinFor, StaticMixin } from './mixin.js'
export type { RequirementToken } from './requirement.js'
export type { ResolveOptions, SlotAttributes } from './resolver.js'
export type { SlotProtection, UnnamedSlot } from './slot.js'
export type {
  SlotBuilder,
  SlotBuilders,
  SlotViewRender,
  SlotViewTransform,
  SlotViewTransformFor,
} from './slotView.js'
export type { Contract as SlotsContract } from './slots.js'
export type { NamedStyle, StyleCondition, StylePieces, StyleValue } from './style.js'
export type { StyleRule } from './styleRules.js'
export type { Theme as ThemeValue, ThemeTokens } from './theme.js'
