/**
 * The normalized attachment algebra. Style and Behavior both compile to a
 * `SlotContribution`, so one resolver owns conflict and merge semantics.
 *
 * A contribution is either static data (Style) or a function of the render
 * context (`input` and the view's `h`) — Behavior uses the dynamic form so its
 * attributes are built with the Message universe of the view it is attached to.
 * `input` is `unknown` here; the Behavior authoring helpers re-narrow it.
 */
import type { Attribute, ChildAttribute, HtmlBuilder } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'

export interface StaticContribution<Message> {
  readonly classes?: ReadonlyArray<string>
  readonly style?: Readonly<Record<string, string>>
  readonly attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
  readonly mounts?: ReadonlyArray<MountAction<Message, any>>
}

export interface ContributionContext<Message> {
  readonly input: unknown
  readonly h: HtmlBuilder<Message>
}

export type DynamicContribution<Message> = (
  context: ContributionContext<Message>,
) => StaticContribution<Message>

export type SlotContribution<Message> = StaticContribution<Message> | DynamicContribution<Message>

export type Contribution<Message> = {
  readonly [slot: string]: SlotContribution<Message> | undefined
}

export type StaticContributionMap<Message> = {
  readonly [slot: string]: StaticContribution<Message> | undefined
}
