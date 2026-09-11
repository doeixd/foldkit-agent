/**
 * The pure requirement planner.
 *
 * A `Requirement` is plain data: which entity fields a Remote projection needs.
 * `plan` diffs requirements against the store and returns only the missing
 * fields, grouped and deterministically ordered. Time enters through
 * `PlanFreshness`, never from ambient state.
 */
import type { Requirement } from 'foldkit-surface'
import { entityKey, missingFields, type EntityStore } from './store.js'

export type { Requirement } from 'foldkit-surface'

type Window = NonNullable<Requirement['windows']>[string]

/** A stable key for a window, so two equal windows compare equal. */
export const windowKey = (window: Window): string =>
  JSON.stringify([
    window.first ?? null,
    window.last ?? null,
    window.after ?? null,
    window.before ?? null,
  ])

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
    {
      entity: string
      id: string
      fields: string[]
      seen: Set<string>
      windows: Map<string, Window>
    }
  >()

  for (const requirement of requirements) {
    const key = entityKey(requirement.entity, requirement.id)
    let group = grouped.get(key)
    if (group === undefined) {
      group = {
        entity: requirement.entity,
        id: requirement.id,
        fields: [],
        seen: new Set(),
        windows: new Map(),
      }
      grouped.set(key, group)
    }
    for (const field of requirement.fields) {
      if (group.seen.has(field)) continue
      group.seen.add(field)
      group.fields.push(field)
    }
    for (const [field, window] of Object.entries(requirement.windows ?? {})) {
      group.windows.set(field, window)
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
    const windowKeys = Object.fromEntries(
      [...group.windows].map(([field, window]) => [field, windowKey(window)]),
    )
    const missing = expired ? group.fields : missingFields(store, key, group.fields, windowKeys)
    if (missing.length === 0) continue
    // Only a field being fetched carries its window.
    const missingSet = new Set(missing)
    const windows = Object.fromEntries(
      [...group.windows].filter(([field]) => missingSet.has(field)),
    )
    planned.push({
      entity: group.entity,
      id: group.id,
      fields: missing,
      ...(Object.keys(windows).length === 0 ? {} : { windows }),
    })
  }
  return planned
}
