import { Config, Effect, type Scope } from 'effect'
import { StorageError } from './errors.js'

/** Persists a replica's state with compare-and-swap on its revision. */
export interface Storage<State = unknown> {
  load: () => Effect.Effect<unknown, StorageError>
  save: (state: State, expectedRevision: number | null) => Effect.Effect<void, StorageError>
  /** Idempotent; the caller closes the connection explicitly. */
  close: Effect.Effect<void>
}

const storageError = (message: string, cause: unknown): StorageError =>
  new StorageError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  })

const openDatabase = (
  name: string,
  factory: IDBFactory,
): Effect.Effect<IDBDatabase, StorageError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(name, 1)
        request.onupgradeneeded = () => request.result.createObjectStore('replica')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        // Without this, a version upgrade blocked by another open connection
        // never settles and the effect hangs.
        request.onblocked = () =>
          reject(new Error('IndexedDB upgrade is blocked by another connection'))
      }),
    catch: cause => storageError('Could not open the storage', cause),
  })

/** One database per document/replica; CAS prevents two tabs from sharing a writer identity. */
export const indexedDb = <State = unknown>(
  name: Config.Config<string> | string,
  factory: IDBFactory = globalThis.indexedDB,
): Effect.Effect<Storage<State>, StorageError, Scope.Scope> =>
  Effect.gen(function* () {
    const databaseName =
      typeof name === 'string'
        ? name
        : yield* name.pipe(
            Effect.mapError(cause => storageError('Could not read the storage name', cause)),
          )
    const database = yield* Effect.acquireRelease(openDatabase(databaseName, factory), database =>
      Effect.sync(() => database.close()),
    )
    database.onversionchange = () => database.close()
    return {
      load: () =>
        Effect.tryPromise({
          try: () =>
            new Promise((resolve, reject) => {
              const transaction = database.transaction('replica', 'readonly')
              const request = transaction.objectStore('replica').get('state')
              transaction.oncomplete = () => resolve(request.result)
              transaction.onabort = () =>
                reject(transaction.error ?? new Error('IndexedDB read aborted'))
            }),
          catch: cause => storageError('Could not read the replica', cause),
        }),
      save: (state, expectedRevision) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              const transaction = database.transaction('replica', 'readwrite', {
                durability: 'strict',
              })
              const store = transaction.objectStore('replica')
              const request = store.get('state')
              let conflict = false
              request.onsuccess = () => {
                const current = request.result as { revision: number } | undefined
                if ((current?.revision ?? null) !== expectedRevision) {
                  conflict = true
                  transaction.abort()
                  return
                }
                store.put(state, 'state')
              }
              transaction.oncomplete = () => resolve()
              transaction.onabort = () =>
                reject(
                  conflict
                    ? new Error('Replica was changed by another writer')
                    : (transaction.error ?? new Error('IndexedDB write aborted')),
                )
            }),
          catch: cause => storageError('Could not save the replica', cause),
        }),
      close: Effect.sync(() => database.close()),
    }
  })
