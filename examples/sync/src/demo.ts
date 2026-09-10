import { strict as assert } from 'node:assert'
import { IDBFactory } from 'fake-indexeddb'
import { Agent } from 'foldkit-agent'
import { Effect } from 'effect'
import { Message } from './app.js'
import { indexedDb } from './indexedDb.js'
import { openJournal } from './journal.js'
import { openReplica } from './replica.js'

const factory = new IDBFactory()
const server = openJournal(':memory:')
const principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const transport = server.transport(principal)
const alice = await openReplica('todos', 'alice', await indexedDb('alice', factory))
let bob = await openReplica('todos', 'bob', await indexedDb('bob', factory))
await alice.submit(Message.CreatedTodo({ id: 'a', title: 'Alice offline' }))
await bob.submit(Message.CreatedTodo({ id: 'b', title: 'Bob offline' }))
await bob.close()
bob = await openReplica('todos', 'bob', await indexedDb('bob', factory))
assert.equal(bob.pending().length, 1)
await bob.synchronize(transport)
await alice.synchronize(transport)
await bob.synchronize(transport)
assert.deepEqual(alice.shared(), bob.shared())

const agent = Agent.bind({
  definition: Agent.define({
    messages: Agent.expose(Message, {
      RenamedTodo: { name: 'rename_todo', description: 'Rename a shared todo' },
    }),
  }),
  host: {
    model: () => server.snapshot('todos').model,
    dispatch: (message: typeof Message.Type) => {
      server.append(
        {
          protocolVersion: 1,
          schemaVersion: 1,
          documentId: 'todos',
          replicaId: 'agent',
          opId: 'agent:1',
          localSequence: 1,
          baseCursor: server.snapshot('todos').cursor,
          message,
        },
        principal,
      )
    },
  },
})
await Effect.runPromise(
  agent.messages.dispatch('rename_todo', { id: 'a', title: 'Renamed by agent' }),
)
await alice.synchronize(transport)
await bob.synchronize(transport)
assert.deepEqual(alice.shared(), bob.shared())
assert.deepEqual(alice.shared(), server.snapshot('todos').model)
console.log(
  'Recovered an offline outbox, converged two replicas, and replayed a server agent Message.',
)
console.log(JSON.stringify(alice.shared()))
await alice.close()
await bob.close()
server.close()
