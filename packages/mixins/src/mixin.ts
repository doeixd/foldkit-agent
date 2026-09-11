/**
 * `Mixin` is the common algebra: a named set of per-slot contributions.
 * Style and Behavior normalize into it so one resolver owns merge and
 * conflict semantics. Composition is immutable and order-preserving.
 */
import type { Contribution, SlotContribution } from './contribution.js'

export interface Mixin<Message> {
  readonly name: string
  readonly contributions: Contribution<Message>
}

const mergeSlot = <Message>(
  left: SlotContribution<Message>,
  right: SlotContribution<Message>,
): SlotContribution<Message> =>
  Object.freeze({
    classes: Object.freeze([...(left.classes ?? []), ...(right.classes ?? [])]),
    style: Object.freeze({ ...(left.style ?? {}), ...(right.style ?? {}) }),
    attributes: Object.freeze([...(left.attributes ?? []), ...(right.attributes ?? [])]),
    mounts: Object.freeze([...(left.mounts ?? []), ...(right.mounts ?? [])]),
  })

export const make = <Message>(name: string, contributions: Contribution<Message>): Mixin<Message> =>
  Object.freeze({ name, contributions: Object.freeze({ ...contributions }) })

export const empty = <Message = never>(): Mixin<Message> => make('Empty', {})

export const compose = <Message>(...mixins: ReadonlyArray<Mixin<Message>>): Mixin<Message> => {
  const merged: Record<string, SlotContribution<Message>> = {}
  for (const mixin of mixins) {
    for (const [slot, contribution] of Object.entries(mixin.contributions)) {
      if (contribution === undefined) continue
      const existing = merged[slot]
      merged[slot] = existing === undefined ? contribution : mergeSlot(existing, contribution)
    }
  }
  return make(mixins.length === 0 ? 'Empty' : mixins.map(mixin => mixin.name).join('+'), merged)
}

export const contributionsFor = <Message>(
  mixin: Mixin<Message>,
  slot: string,
): SlotContribution<Message> | undefined => mixin.contributions[slot]
