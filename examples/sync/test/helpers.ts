import { Effect } from 'effect'
import { layerFromPromise, type Operation, type Replica, type TransportClient } from 'foldkit-sync'
import type { Message, Shared } from '../src/app.js'
import { Sync } from '../src/sync.js'

export type TodoReplica = Replica<Message, Shared>

/** The Effect-native replica, for tests that embed it in the Foldkit runtime. */
export const openReplicaEffect = (
  id: string,
  storage: Parameters<typeof Sync.openReplica>[1],
): Promise<TodoReplica> => Effect.runPromise(Sync.openReplica(id, storage))

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
