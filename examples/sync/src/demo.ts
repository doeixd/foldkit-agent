import { strict as assert } from 'node:assert'
import { IDBFactory } from 'fake-indexeddb'
import { Agent } from 'foldkit-agent'
import {
  createPresence,
  indexedDb,
  layerFromPromise,
  loopbackPresenceChannel,
  type Replica,
  type TransportClient,
} from 'foldkit-sync'
import { Effect } from 'effect'
import { Message, type Shared } from './app.js'
import { openJournal, type Principal } from './journal.js'
import { serverAgentHost } from './serverAgent.js'
import { Sync } from './sync.js'

type TodoReplica = Replica<Message, Shared>
const open = (id: string, storage: Awaited<ReturnType<typeof indexedDb>>): Promise<TodoReplica> =>
  Effect.runPromise(Sync.openReplica(id, storage))
const submit = (replica: TodoReplica, message: Message): Promise<void> =>
  Effect.runPromise(replica.submit(message))
const synchronize = (replica: TodoReplica, transport: TransportClient): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerFromPromise(transport)))
const shared = (replica: TodoReplica): Shared => Effect.runSync(replica.shared)
const pending = (replica: TodoReplica) => Effect.runSync(replica.pending)
const close = (replica: TodoReplica): Promise<void> => Effect.runPromise(replica.close)

const factory = new IDBFactory()
const server = openJournal(':memory:')
const principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const transport = server.transport(principal)
const alice = await open('alice', await indexedDb('alice', factory))
let bob = await open('bob', await indexedDb('bob', factory))
await submit(alice, Message.CreatedTodo({ id: 'a', title: 'Alice offline' }))
await submit(bob, Message.CreatedTodo({ id: 'b', title: 'Bob offline' }))
await close(bob)
bob = await open('bob', await indexedDb('bob', factory))
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
// or replayed. An injected clock makes the TTL deterministic.
let clock = 1_000
const presence = loopbackPresenceChannel<{ selectedTodoId: string }>()
const alicePresence = createPresence<{ selectedTodoId: string }>({
  id: 'alice',
  ttl: 5_000,
  channel: presence,
  now: () => clock,
})
const bobPresence = createPresence<{ selectedTodoId: string }>({
  id: 'bob',
  ttl: 5_000,
  channel: presence,
  now: () => clock,
})
alicePresence.set({ selectedTodoId: 'a' })
assert.deepEqual(
  bobPresence.peers().map(peer => [peer.id, peer.value.selectedTodoId]),
  [['alice', 'a']],
)
clock = 6_001
bobPresence.prune()
assert.deepEqual(bobPresence.peers(), [])
alicePresence.close()
bobPresence.close()

console.log(
  'Recovered an offline outbox, converged two replicas, replayed two server agent Messages, and let a presence peer expire.',
)
console.log(JSON.stringify(shared(alice)))
await close(alice)
await close(bob)
server.close()
