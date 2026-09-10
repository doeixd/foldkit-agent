/** Persists a replica's state with compare-and-swap on its revision. */
export interface Storage<State = unknown> {
  load(): Promise<unknown>
  save(state: State, expectedRevision: number | null): Promise<void>
  close(): void
}

/** One database per document/replica; CAS prevents two tabs from sharing a writer identity. */
export const indexedDb = async <State = unknown>(
  name: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<Storage<State>> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('replica')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.onversionchange = () => database.close()
  return {
    load: () =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction('replica', 'readonly')
        const request = transaction.objectStore('replica').get('state')
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read aborted'))
      }),
    save: (state, expectedRevision) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction('replica', 'readwrite', { durability: 'strict' })
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
    close: () => database.close(),
  }
}
