import { strict as assert } from 'node:assert'
import { IDBFactory } from 'fake-indexeddb'
import { Agent } from 'foldkit-agent'
import { indexedDb } from 'foldkit-sync'
import { Effect } from 'effect'
import { Message, type Shared } from './app.js'
import { openJournal, type Principal } from './journal.js'
import { serverAgentHost } from './serverAgent.js'
import { Sync } from './sync.js'

const factory = new IDBFactory()
const server = openJournal(':memory:')
const principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const transport = server.transport(principal)
const alice = await Sync.openReplica('alice', await indexedDb('alice', factory))
let bob = await Sync.openReplica('bob', await indexedDb('bob', factory))
await alice.submit(Message.CreatedTodo({ id: 'a', title: 'Alice offline' }))
await bob.submit(Message.CreatedTodo({ id: 'b', title: 'Bob offline' }))
await bob.close()
bob = await Sync.openReplica('bob', await indexedDb('bob', factory))
assert.equal(bob.pending().length, 1)
await bob.synchronize(transport)
await alice.synchronize(transport)
await bob.synchronize(transport)
assert.deepEqual(alice.shared(), bob.shared())

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
await alice.synchronize(transport)
await bob.synchronize(transport)
assert.deepEqual(alice.shared(), bob.shared())
assert.deepEqual(alice.shared(), server.snapshot('todos').model)
assert.deepEqual(alice.shared().todos, [
  { id: 'b', title: 'Renamed by agent too' },
  { id: 'a', title: 'Renamed by agent' },
])
console.log(
  'Recovered an offline outbox, converged two replicas, and replayed two server agent Messages.',
)
console.log(JSON.stringify(alice.shared()))
await alice.close()
await bob.close()
server.close()
