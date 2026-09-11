import { Effect, Exit, Scope } from 'effect'
import {
  indexedDb,
  layerFromPromise,
  replicaId,
  StorageError,
  type Operation,
  type Replica,
  type Storage,
  type TransportClient,
} from 'foldkit-sync'
import type { Message, Shared } from '../src/app.js'
import { Sync } from '../src/sync.js'

export type TodoReplica = Replica<Message, Shared>

const scopes: Array<Scope.Closeable> = []

/**
 * Opens IndexedDB storage in a scope that `closeStorages` releases, so the
 * connection lives past this call. It mirrors `indexedDb`, minus the scope.
 */
export const openStorage = (
  name: string,
  factory?: IDBFactory,
): Effect.Effect<Storage, StorageError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    scopes.push(scope)
    return yield* Effect.provideService(indexedDb(name, factory), Scope.Scope, scope)
  })

/** Releases every storage opened by `openStorage` in this test file. */
export const closeStorages = (): Promise<void> =>
  Effect.runPromise(
    Effect.forEach(scopes.splice(0), scope => Scope.close(scope, Exit.void), { discard: true }),
  )

/** The Effect-native replica, for tests that embed it in the Foldkit runtime. */
export const openReplicaEffect = (
  id: string,
  storage: Parameters<typeof Sync.openReplica>[1],
): Promise<TodoReplica> => Effect.runPromise(Sync.openReplica(replicaId(id), storage))

/** A promise facade, so app-level test bodies read as they did before. */
export interface PromiseReplica {
  shared(): Shared
  pending(): ReadonlyArray<Operation>
  cursor(): number
  submit(message: Message): Promise<void>
  synchronize(transport: TransportClient): Promise<void>
  close(): Promise<void>
}

const replicaFacade = (replica: TodoReplica): PromiseReplica => ({
  shared: () => Effect.runSync(replica.shared),
  pending: () => Effect.runSync(replica.pending),
  cursor: () => Effect.runSync(replica.cursor),
  submit: message => Effect.runPromise(replica.submit(message)),
  synchronize: transport =>
    Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport))),
  close: () => Effect.runPromise(replica.close),
})

export const openReplica = async (
  id: string,
  storage: Parameters<typeof Sync.openReplica>[1],
): Promise<PromiseReplica> => replicaFacade(await openReplicaEffect(id, storage))
