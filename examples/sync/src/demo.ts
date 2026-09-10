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
      // The agent is its own replica, but has no persisted outbox here. The
      // document cursor only ever advances, so deriving its sequence from that
      // keeps each dispatch's identity unique without a second counter to keep
      // in sync. Hard-coding `agent:1` made the second dispatch collide and the
      // journal reject it as an identity conflict.
      const baseCursor = server.snapshot('todos').cursor
      server.append(
        {
          protocolVersion: 1,
          schemaVersion: 1,
          documentId: 'todos',
          replicaId: 'agent',
          opId: `agent:${baseCursor + 1}`,
          localSequence: baseCursor + 1,
          baseCursor,
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
