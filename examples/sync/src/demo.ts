import { strict as assert } from 'node:assert'
import { IDBFactory } from 'fake-indexeddb'
import { Agent } from 'foldkit-agent'
import {
  createPresence,
  indexedDb,
  layerFromPromise,
  loopbackPresenceChannel,
  replicaId,
  type Replica,
  type TransportClient,
} from 'foldkit-sync'
import { Clock, Effect, Exit, Layer, Schema, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { Message, type Shared } from './app.js'
import { openJournal, type Principal } from './journal.js'
import { serverAgentHost } from './serverAgent.js'
import { Sync } from './sync.js'

type TodoReplica = Replica<Message, Shared>
const open = (id: string, storage: Parameters<typeof Sync.openReplica>[1]): Promise<TodoReplica> =>
  Effect.runPromise(Sync.openReplica(replicaId(id), storage))
const submit = (replica: TodoReplica, message: Message): Promise<void> =>
  Effect.runPromise(replica.submit(message))
const synchronize = (replica: TodoReplica, transport: TransportClient): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport)))
const shared = (replica: TodoReplica): Shared => Effect.runSync(replica.shared)
const pending = (replica: TodoReplica) => Effect.runSync(replica.pending)
const close = (replica: TodoReplica): Promise<void> => Effect.runPromise(replica.close)

const factory = new IDBFactory()
// The IndexedDB connections share one scope, released at the end of the demo.
const storageScope = Effect.runSync(Scope.make())
const openStorage = (name: string, factory: IDBFactory) =>
  Effect.runPromise(Effect.provideService(indexedDb(name, factory), Scope.Scope, storageScope))
const server = openJournal(':memory:')
const principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const transport = server.transport(principal)
const alice = await open('alice', await openStorage('alice', factory))
let bob = await open('bob', await openStorage('bob', factory))
await submit(alice, Message.CreatedTodo({ id: 'a', title: 'Alice offline' }))
await submit(bob, Message.CreatedTodo({ id: 'b', title: 'Bob offline' }))
await close(bob)
bob = await open('bob', await openStorage('bob', factory))
assert.equal(pending(bob).length, 1)
await synchronize(bob, transport)
await synchronize(alice, transport)
await synchronize(bob, transport)
assert.deepEqual(shared(alice), shared(bob))

const SyncAgent = Agent.forModel<Shared, Principal>()
const agent = Agent.bind({
  definition: SyncAgent.define({
    messages: SyncAgent.expose(Message, {
      RenamedTodo: { name: 'rename_todo', description: 'Rename a shared todo' },
    }),
  }),
  host: serverAgentHost({ journal: server, principal }),
})
await Effect.runPromise(
  agent.messages.dispatch('rename_todo', { id: 'a', title: 'Renamed by agent' }),
)
await Effect.runPromise(
  agent.messages.dispatch('rename_todo', { id: 'b', title: 'Renamed by agent too' }),
)
await synchronize(alice, transport)
await synchronize(bob, transport)
assert.deepEqual(shared(alice), shared(bob))
assert.deepEqual(shared(alice), server.snapshot('todos').model)
assert.deepEqual(shared(alice).todos, [
  { id: 'b', title: 'Renamed by agent too' },
  { id: 'a', title: 'Renamed by agent' },
])

// Presence is ephemeral: selection is shared between peers and never persisted
// or replayed. A TestClock makes the TTL deterministic.
const SelectedTodoPresence = Schema.Struct({ selectedTodoId: Schema.String })
const decodeSelectedTodo = Schema.decodeUnknownSync(SelectedTodoPresence)
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const presence = yield* loopbackPresenceChannel<{ selectedTodoId: string }>()
      const alicePresence = yield* createPresence<{ selectedTodoId: string }>({
        id: 'alice',
        ttl: '5 seconds',
        channel: presence,
        decodeValue: decodeSelectedTodo,
      })
      const bobPresence = yield* createPresence<{ selectedTodoId: string }>({
        id: 'bob',
        ttl: '5 seconds',
        channel: presence,
        decodeValue: decodeSelectedTodo,
      })

      // Let both channel consumers subscribe before anything is published.
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* alicePresence.set({ selectedTodoId: 'a' })
      // Let the sibling's channel consumer drain the publish.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.deepEqual(
        (yield* bobPresence.peers).map(peer => [peer.id, peer.value.selectedTodoId]),
        [['alice', 'a']],
      )

      yield* TestClock.adjust('6 seconds')
      yield* bobPresence.prune
      assert.deepEqual(yield* bobPresence.peers, [])
    }).pipe(
      Effect.provide(TestClock.layer() as unknown as Layer.Layer<Clock.Clock>),
    ) as Effect.Effect<void, never, Scope.Scope>,
  ),
)

console.log(
  'Recovered an offline outbox, converged two replicas, replayed two server agent Messages, and let a presence peer expire.',
)
console.log(JSON.stringify(shared(alice)))
await close(alice)
await close(bob)
server.close()
await Effect.runPromise(Scope.close(storageScope, Exit.void))
