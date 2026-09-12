/**
 * The pure requirement planner.
 *
 * A `Requirement` is plain data: which entity fields a Remote projection needs,
 * and through `relations`, which fields of each relation's target. `plan` diffs
 * requirements against the store and returns only the missing fields, grouped
 * and deterministically ordered. A relation whose field is being fetched keeps
 * its nested requirement on the request, so the server resolves the graph in
 * one read; a relation whose refs the store already holds is followed into
 * concrete requirements for the targets. Time enters through `PlanFreshness`,
 * never from ambient state; `force` plans every field.
 */
import { Requirement, type RelationRequirement } from 'foldkit-surface'
import { refsIn } from './relation.js'
import { entityKey, missingFields, readField, type EntityStore } from './store.js'

export type { RelationRequirement, Requirement } from 'foldkit-surface'

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

export interface PlanOptions {
  readonly freshness?: PlanFreshness | undefined
  /** Plan every requested field, present or not, tombstoned or not. */
  readonly force?: boolean | undefined
}

const pickFields = <T>(
  record: Readonly<Record<string, T>> | undefined,
  fields: ReadonlySet<string>,
): Readonly<Record<string, T>> | undefined => {
  if (record === undefined) return undefined
  const picked = Object.fromEntries(Object.entries(record).filter(([field]) => fields.has(field)))
  return Object.keys(picked).length === 0 ? undefined : picked
}

/** The concrete requirements a known relation value contributes for its targets. */
const followRelation = (
  value: unknown,
  relation: RelationRequirement,
): ReadonlyArray<Requirement> =>
  refsIn(value)
    .filter(ref => ref.entity === relation.entity)
    .map(ref => ({
      entity: relation.entity,
      id: ref.id,
      fields: relation.fields,
      ...(relation.windows === undefined ? {} : { windows: relation.windows }),
      ...(relation.relations === undefined ? {} : { relations: relation.relations }),
    }))

export const plan = (
  store: EntityStore,
  requirements: readonly Requirement[],
  options: PlanOptions = {},
): ReadonlyArray<Requirement> => {
  const { freshness, force = false } = options
  const planned: Requirement[] = []
  const followed: Requirement[] = []

  for (const group of Requirement.merge(requirements)) {
    const key = entityKey(group.entity, group.id)
    const entry = store[key]
    const expired =
      freshness !== undefined &&
      entry !== undefined &&
      !entry.tombstone &&
      freshness.now - entry.updatedAt > freshness.freshness
    const windowKeys = Object.fromEntries(
      Object.entries(group.windows ?? {}).map(([field, window]) => [field, windowKey(window)]),
    )
    const missing =
      force || expired ? group.fields : missingFields(store, key, group.fields, windowKeys)
    const missingSet = new Set(missing)

    // A relation the store already holds is followed into its targets; one
    // being fetched rides on the request instead.
    for (const [field, relation] of Object.entries(group.relations ?? {})) {
      if (missingSet.has(field)) continue
      const value = readField(store, key, field)
      if (value._tag === 'Some') followed.push(...followRelation(value.value, relation))
    }

    if (missing.length === 0) continue
    // Only a field being fetched carries its window and its relation.
    const windows = pickFields(group.windows, missingSet)
    const relations = pickFields(group.relations, missingSet)
    planned.push({
      entity: group.entity,
      id: group.id,
      fields: missing,
      ...(windows === undefined ? {} : { windows }),
      ...(relations === undefined ? {} : { relations }),
    })
  }

  const nested = followed.length === 0 ? [] : plan(store, followed, options)
  return [...Requirement.merge([...planned, ...nested])].sort((a, b) =>
    entityKey(a.entity, a.id) < entityKey(b.entity, b.id) ? -1 : 1,
  )
}
