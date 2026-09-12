import { Effect, Exit, Scope } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { indexedDb, replicaId, type Replica, type Storage, type StorageError } from 'foldkit-sync'
import type { Message, Shared } from '../src/app.js'
import { Sync } from '../src/sync.js'

export type TodoReplica = Replica<Message, Shared>

const scopes: Array<Scope.Closeable> = []

/** IndexedDB storage in a scope that `closeStorages` releases. */
export const openStorage = (name: string): Effect.Effect<Storage, StorageError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    scopes.push(scope)
    return yield* Effect.provideService(indexedDb(name, new IDBFactory()), Scope.Scope, scope)
  })

export const closeStorages = (): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(scopes.splice(0), scope => Scope.close(scope, Exit.void), { discard: true }),
  )

export const openReplica = async (id: string): Promise<TodoReplica> =>
  Effect.runPromise(Sync.openReplica(replicaId(id), await Effect.runPromise(openStorage(id))))
