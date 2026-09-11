/**
 * Remote cache persistence over Effect `KeyValueStore`. No storage abstraction:
 * `save`/`restore` depend on the `KeyValueStore` service, so the backend (memory,
 * filesystem, SQL, Web Storage) is chosen by the application.
 *
 * The cache is server-derived and disposable: an incompatible or corrupt
 * snapshot is **removed** and an empty store returned, so the planner refetches.
 */
import { Effect } from 'effect'
import { KeyValueStore } from 'effect/unstable/persistence'
import { emptyStore, type EntityEntry, type EntityStore } from './store.js'

/** Bump when the serialized shape changes; a mismatch discards the cache. */
export const REMOTE_CACHE_VERSION = 2

interface SerializedEntry {
  readonly values: Readonly<Record<string, unknown>>
  readonly present: ReadonlyArray<string>
  readonly stale: ReadonlyArray<string>
  readonly tombstone: boolean
  readonly updatedAt: number
  readonly windows: Readonly<Record<string, string>>
}

interface SerializedStore {
  readonly version: number
  readonly entities: Readonly<Record<string, SerializedEntry>>
}

export const serializeStore = (store: EntityStore): SerializedStore => ({
  version: REMOTE_CACHE_VERSION,
  entities: Object.fromEntries(
    Object.entries(store).map(([key, entry]) => [
      key,
      {
        values: entry.values,
        present: [...entry.present],
        stale: [...entry.stale],
        tombstone: entry.tombstone,
        updatedAt: entry.updatedAt,
        windows: entry.windows,
      },
    ]),
  ),
})

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every(item => typeof item === 'string')

/** Throws on a malformed entry so `restore` can discard the whole snapshot. */
const parseEntry = (value: unknown): EntityEntry => {
  if (value === null || typeof value !== 'object') throw new Error('entry is not an object')
  const entry = value as Record<string, unknown>
  if (entry.values === null || typeof entry.values !== 'object' || Array.isArray(entry.values)) {
    throw new Error('entry.values is not a record')
  }
  if (!isStringArray(entry.present)) throw new Error('entry.present is not a string array')
  if (!isStringArray(entry.stale)) throw new Error('entry.stale is not a string array')
  if (typeof entry.tombstone !== 'boolean') throw new Error('entry.tombstone is not a boolean')
  if (typeof entry.updatedAt !== 'number') throw new Error('entry.updatedAt is not a number')
  if (!isStringRecord(entry.windows)) throw new Error('entry.windows is not a string record')
  return {
    values: entry.values as Readonly<Record<string, unknown>>,
    present: new Set(entry.present),
    stale: new Set(entry.stale),
    tombstone: entry.tombstone,
    updatedAt: entry.updatedAt,
    windows: entry.windows,
  }
}

export const deserializeStore = (serialized: SerializedStore): EntityStore =>
  Object.fromEntries(
    Object.entries(serialized.entities).map(([key, entry]) => [key, parseEntry(entry)]),
  )

export const RemotePersistence = {
  save: (store: EntityStore, options: { readonly key: string }) =>
    Effect.gen(function* () {
      const store_ = yield* KeyValueStore.KeyValueStore
      yield* store_.set(options.key, JSON.stringify(serializeStore(store)))
    }),

  /**
   * Reads the cache. A missing key, invalid JSON, a non-object, a version
   * mismatch, or a malformed snapshot yields `emptyStore` and removes the bad
   * key, so the next `restore` is clean and the planner refetches.
   */
  restore: (options: { readonly key: string }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      const raw = yield* store.get(options.key)
      if (raw === undefined) return emptyStore

      const restored = yield* Effect.sync((): EntityStore | undefined => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return undefined
        }
        if (parsed === null || typeof parsed !== 'object') return undefined
        const candidate = parsed as { readonly version?: unknown; readonly entities?: unknown }
        if (candidate.version !== REMOTE_CACHE_VERSION) return undefined
        if (candidate.entities === null || typeof candidate.entities !== 'object') return undefined
        if (Array.isArray(candidate.entities)) return undefined
        try {
          return deserializeStore(candidate as SerializedStore)
        } catch {
          return undefined
        }
      })

      if (restored === undefined) {
        yield* store.remove(options.key)
        return emptyStore
      }
      return restored
    }),
}
