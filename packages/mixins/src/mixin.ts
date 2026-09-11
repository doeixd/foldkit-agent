/**
 * `Mixin` is the common algebra: a named set of per-slot contributions.
 *
 * `StaticMixin` holds only static contributions, so it stays assignable to any
 * Message universe; Style uses it. `Mixin` may hold deferred contributions and
 * is tied to one Message universe; Behavior uses it. Composition is immutable
 * and keeps the deferred form when either side is deferred.
 */
import type {
  Contribution,
  ContributionContext,
  DynamicContribution,
  SlotContribution,
  StaticContribution,
  StaticContributionMap,
} from './contribution.js'

export interface Mixin<Message = never> {
  readonly name: string
  readonly contributions: Contribution<Message>
}

export interface StaticMixin<Message = never> {
  readonly name: string
  readonly contributions: StaticContributionMap<Message>
}

export type AnyMixin = Mixin<any> | StaticMixin<any>

export const isDynamic = <Message>(
  contribution: SlotContribution<Message>,
): contribution is DynamicContribution<Message> => typeof contribution === 'function'

export const evaluate = <Message>(
  contribution: SlotContribution<Message>,
  context: ContributionContext<Message>,
): StaticContribution<Message> => (isDynamic(contribution) ? contribution(context) : contribution)

const mergeStatic = <Message>(
  left: StaticContribution<Message>,
  right: StaticContribution<Message>,
): StaticContribution<Message> =>
  Object.freeze({
    classes: Object.freeze([...(left.classes ?? []), ...(right.classes ?? [])]),
    style: Object.freeze({ ...(left.style ?? {}), ...(right.style ?? {}) }),
    attributes: Object.freeze([...(left.attributes ?? []), ...(right.attributes ?? [])]),
    mounts: Object.freeze([...(left.mounts ?? []), ...(right.mounts ?? [])]),
  })

const mergeSlot = <Message>(
  left: SlotContribution<Message>,
  right: SlotContribution<Message>,
): SlotContribution<Message> => {
  if (!isDynamic(left) && !isDynamic(right)) return mergeStatic(left, right)
  return context => mergeStatic(evaluate(left, context), evaluate(right, context))
}

export const make = <Message = never>(
  name: string,
  contributions: StaticContributionMap<Message>,
): StaticMixin<Message> =>
  Object.freeze({ name, contributions: Object.freeze({ ...contributions }) })

export const dynamic = <Message = never>(
  name: string,
  contributions: Contribution<Message>,
): Mixin<Message> => Object.freeze({ name, contributions: Object.freeze({ ...contributions }) })

export const empty = <Message = never>(): StaticMixin<Message> => make('Empty', {})

export const compose = <Message>(
  ...mixins: ReadonlyArray<Mixin<Message> | StaticMixin<Message>>
): Mixin<Message> => {
  const merged: Record<string, SlotContribution<Message>> = {}
  for (const mixin of mixins) {
    for (const [slot, contribution] of Object.entries(mixin.contributions)) {
      if (contribution === undefined) continue
      const existing = merged[slot]
      merged[slot] = existing === undefined ? contribution : mergeSlot(existing, contribution)
    }
  }
  return dynamic(mixins.length === 0 ? 'Empty' : mixins.map(mixin => mixin.name).join('+'), merged)
}

export const contributionsFor = <Message>(
  mixin: Mixin<Message> | StaticMixin<Message>,
  slot: string,
): SlotContribution<Message> | undefined => mixin.contributions[slot]
