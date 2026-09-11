/**
 * The pure requirement planner.
 *
 * A `Requirement` is plain data: which entity fields a Remote projection needs.
 * `plan` diffs requirements against the store and returns only the missing
 * fields, grouped and deterministically ordered. Time enters through
 * `PlanFreshness`, never from ambient state.
 */
import { entityKey, missingFields, type EntityStore } from './store.js'

export interface Requirement {
  readonly entity: string
  readonly id: string
  readonly fields: readonly string[]
}

export interface PlanFreshness {
  readonly now: number
  /** A present entry older than this many milliseconds is refreshed whole. */
  readonly freshness: number
}

export const plan = (
  store: EntityStore,
  requirements: readonly Requirement[],
  freshness?: PlanFreshness,
): ReadonlyArray<Requirement> => {
  const grouped = new Map<
    string,
    { entity: string; id: string; fields: string[]; seen: Set<string> }
  >()

  for (const requirement of requirements) {
    const key = entityKey(requirement.entity, requirement.id)
    let group = grouped.get(key)
    if (group === undefined) {
      group = { entity: requirement.entity, id: requirement.id, fields: [], seen: new Set() }
      grouped.set(key, group)
    }
    for (const field of requirement.fields) {
      if (group.seen.has(field)) continue
      group.seen.add(field)
      group.fields.push(field)
    }
  }

  const planned: Requirement[] = []
  for (const key of [...grouped.keys()].sort()) {
    const group = grouped.get(key)!
    const entry = store[key]
    const expired =
      freshness !== undefined &&
      entry !== undefined &&
      !entry.tombstone &&
      freshness.now - entry.updatedAt > freshness.freshness
    const missing = expired ? group.fields : missingFields(store, key, group.fields)
    if (missing.length > 0) {
      planned.push({ entity: group.entity, id: group.id, fields: missing })
    }
  }
  return planned
}
