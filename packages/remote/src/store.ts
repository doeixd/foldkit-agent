/**
 * The pure entity store: values, per-field presence, staleness, and tombstones.
 *
 * Presence is tracked **separately** from values, so `undefined`/`null`/absent/
 * stale/not-found are distinct states and a missing field is never inferred from
 * `value === undefined`. Nothing here performs I/O; every operation returns a
 * new store.
 */
import { Option } from 'effect'

export type EntityKey = string

export interface EntityEntry {
  readonly values: Readonly<Record<string, unknown>>
  readonly present: ReadonlySet<string>
  /** Present fields whose value may be outdated (revalidation needed). */
  readonly stale: ReadonlySet<string>
  /** The entity is known to be absent; a later write clears this. */
  readonly tombstone: boolean
  /** Injected clock reading of the last write; never read from ambient state. */
  readonly updatedAt: number
  /**
   * The canonical window each present field was fetched with (`""` for none).
   * A later request with a *known, different* window is planned as missing.
   */
  readonly windows: Readonly<Record<string, string>>
}

export type EntityStore = Readonly<Record<EntityKey, EntityEntry>>

/** The separator keeps an untrusted id from colliding with a prototype key. */
export const entityKey = (entity: string, id: string): EntityKey => `${entity}:${id}`

const emptyEntry: EntityEntry = {
  values: {},
  present: new Set(),
  stale: new Set(),
  tombstone: false,
  updatedAt: 0,
  windows: {},
}

export const emptyStore: EntityStore = {}

const replace = (store: EntityStore, key: EntityKey, entry: EntityEntry): EntityStore => ({
  ...store,
  [key]: entry,
})

const written = (
  previous: EntityEntry,
  values: Readonly<Record<string, unknown>>,
  now: number,
  windows?: Readonly<Record<string, string>>,
): EntityEntry => {
  const present = new Set(previous.present)
  const stale = new Set(previous.stale)
  const nextWindows: Record<string, string> = { ...previous.windows }
  for (const field of Object.keys(values)) {
    present.add(field)
    stale.delete(field)
    // A write without a window clears any remembered one: the value changed.
    const requested = windows?.[field]
    if (requested !== undefined && requested !== '') nextWindows[field] = requested
    else delete nextWindows[field]
  }
  return {
    values: { ...previous.values, ...values },
    present,
    stale,
    tombstone: false,
    updatedAt: now,
    windows: nextWindows,
  }
}

export interface EntityWrite {
  readonly key: EntityKey
  readonly values: Readonly<Record<string, unknown>>
  /** The canonical window each written relation field was fetched with. */
  readonly windows?: Readonly<Record<string, string>> | undefined
}

/**
 * Merges known values into many entities, copying the store once. Every
 * written field becomes present and non-stale; a tombstone is cleared because
 * the entity is evidently not absent.
 */
export const writeEntities = (
  store: EntityStore,
  writes: ReadonlyArray<EntityWrite>,
  now = 0,
): EntityStore => {
  if (writes.length === 0) return store
  const next: Record<EntityKey, EntityEntry> = { ...store }
  for (const write of writes) {
    next[write.key] = written(next[write.key] ?? emptyEntry, write.values, now, write.windows)
  }
  return next
}

/** `writeEntities` for one entity. */
export const writeEntity = (
  store: EntityStore,
  key: EntityKey,
  values: Readonly<Record<string, unknown>>,
  now = 0,
  windows?: Readonly<Record<string, string>>,
): EntityStore => writeEntities(store, [{ key, values, windows }], now)

/**
 * Marks present fields stale (`true`) or ends their staleness (`false`) across
 * many entities, copying the store once. A field never present stays missing;
 * an unknown entity is left alone.
 */
export const setStale = (
  store: EntityStore,
  marks: ReadonlyArray<readonly [key: EntityKey, fields: Iterable<string>]>,
  stale: boolean,
): EntityStore => {
  let next: Record<EntityKey, EntityEntry> | undefined
  for (const [key, fields] of marks) {
    const previous = (next ?? store)[key]
    if (previous === undefined) continue
    const staleFields = new Set(previous.stale)
    for (const field of fields) {
      if (stale) {
        if (previous.present.has(field)) staleFields.add(field)
      } else staleFields.delete(field)
    }
    next ??= { ...store }
    next[key] = { ...previous, stale: staleFields }
  }
  return next ?? store
}

/** Marks present fields stale; fields that were never present stay missing. */
export const markStale = (
  store: EntityStore,
  key: EntityKey,
  fields: Iterable<string>,
): EntityStore => setStale(store, [[key, fields]], true)

/** Ends a refresh that did not land: the fields are present again as they were. */
export const clearStale = (
  store: EntityStore,
  key: EntityKey,
  fields: Iterable<string>,
): EntityStore => setStale(store, [[key, fields]], false)

/** Records that the entity is known to be absent, so it is not refetched. */
export const tombstone = (store: EntityStore, key: EntityKey): EntityStore =>
  replace(store, key, {
    values: {},
    present: new Set(),
    stale: new Set(),
    tombstone: true,
    updatedAt: 0,
    windows: {},
  })

/** Forgets everything known about the entity, including a tombstone. */
export const remove = (store: EntityStore, key: EntityKey): EntityStore => {
  if (store[key] === undefined) return store
  const next = { ...store }
  delete next[key]
  return next
}

export const entry = (store: EntityStore, key: EntityKey): Option.Option<EntityEntry> => {
  const value = store[key]
  return value === undefined ? Option.none() : Option.some(value)
}

export const isTombstone = (store: EntityStore, key: EntityKey): boolean =>
  store[key]?.tombstone === true

/** A field is known only if it is present and not stale. */
export const hasField = (store: EntityStore, key: EntityKey, field: string): boolean => {
  const value = store[key]
  return (
    value !== undefined && !value.tombstone && value.present.has(field) && !value.stale.has(field)
  )
}

/** A present field whose value may be outdated; absent fields are not stale. */
export const isFieldStale = (store: EntityStore, key: EntityKey, field: string): boolean => {
  const value = store[key]
  return value !== undefined && !value.tombstone && value.stale.has(field)
}

/**
 * Reads a present field, stale or not. Absence and a tombstone both yield
 * `Option.none()`; a present `undefined`/`null` yields `Option.some`.
 */
export const readField = (
  store: EntityStore,
  key: EntityKey,
  field: string,
): Option.Option<unknown> => {
  const value = store[key]
  if (value === undefined || value.tombstone || !value.present.has(field)) return Option.none()
  return Option.some(value.values[field])
}

/**
 * The fields the planner must fetch. A tombstone makes every field known
 * (absent), so it returns an empty list and the entity is not refetched. A
 * requested window that differs from the one a field was fetched with also
 * marks it missing, but only when the stored window is known (never `""`), so a
 * writer that does not record windows cannot cause a refetch loop.
 */
export const missingFields = (
  store: EntityStore,
  key: EntityKey,
  fields: Iterable<string>,
  windows?: Readonly<Record<string, string>>,
): ReadonlyArray<string> => {
  const value = store[key]
  if (value !== undefined && value.tombstone) return []
  return [...fields].filter(field => {
    if (value === undefined || !value.present.has(field) || value.stale.has(field)) return true
    const requested = windows?.[field]
    const stored = value.windows[field]
    return requested !== undefined && stored !== undefined && stored !== '' && stored !== requested
  })
}
