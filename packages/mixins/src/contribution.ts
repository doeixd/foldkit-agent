/**
 * The normalized attachment algebra. Style, Behavior, and any future helper
 * all compile to a `SlotContribution`, so one resolver owns conflict and merge
 * semantics.
 */
import type { Attribute, ChildAttribute } from 'foldkit/html'
import type { MountAction } from 'foldkit/mount'

export interface SlotContribution<Message> {
  readonly classes?: ReadonlyArray<string>
  readonly style?: Readonly<Record<string, string>>
  readonly attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
  readonly mounts?: ReadonlyArray<MountAction<Message, any>>
}

export interface Contribution<Message> {
  readonly [slot: string]: SlotContribution<Message> | undefined
}
