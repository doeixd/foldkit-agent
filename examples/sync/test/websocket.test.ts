import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { layerSocket } from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { Message } from '../src/app.js'
import { openJournal, type Principal } from '../src/journal.js'
import { startSyncServer, type SyncServer } from '../src/server.js'
import { closeStorages, openReplicaEffect, openStorage, type TodoReplica } from './helpers.js'

const principal: Principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const accounts: Record<string, Principal> = {
  alice: { actorId: 'alice', documentId: 'todos', canWrite: true },
  bob: { actorId: 'bob', documentId: 'todos', canWrite: false },
}
const authenticate = (token: string | null): Principal | undefined =>
  token === null ? undefined : accounts[token]
const servers: Array<SyncServer> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await closeStorages()
})

const openReplica = async (id: string): Promise<TodoReplica> =>
  openReplicaEffect(id, await Effect.runPromise(openStorage(id, new IDBFactory())))

const sync = (url: string, replica: TodoReplica): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerSocket({ url })))

it('converges a replica over a real WebSocket', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({ journal, authenticate: () => principal })
  servers.push(server)
  const replica = await openReplica('browser')
  try {
    journal.appendAsServer(
      Message.CreatedTodo({ id: 'a', title: 'over the wire' }),
      principal,
      'server',
    )

    await sync(server.url, replica)

    expect(Effect.runSync(replica.cursor)).toBe(1)
    expect(Effect.runSync(replica.shared).todos).toEqual([{ id: 'a', title: 'over the wire' }])
  } finally {
    await Effect.runPromise(replica.close)
    journal.close()
  }
})

it('converges two replicas over the wire', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({ journal, authenticate: () => principal })
  servers.push(server)
  const a = await openReplica('a')
  const b = await openReplica('b')
  try {
    await Effect.runPromise(a.submit(Message.CreatedTodo({ id: 'a', title: 'from a' })))
    await Effect.runPromise(b.submit(Message.CreatedTodo({ id: 'b', title: 'from b' })))

    await Promise.all([sync(server.url, a), sync(server.url, b)])
    await Promise.all([sync(server.url, a), sync(server.url, b)])

    expect(Effect.runSync(a.shared)).toEqual(Effect.runSync(b.shared))
    expect(
      Effect.runSync(a.shared)
        .todos.map(todo => todo.id)
        .sort(),
    ).toEqual(['a', 'b'])
  } finally {
    await Effect.runPromise(a.close)
    await Effect.runPromise(b.close)
    journal.close()
  }
})

it('derives a principal per connection and refuses an unknown token', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({ journal, authenticate })
  servers.push(server)
  const alice = await openReplica('alice')
  const bob = await openReplica('bob')
  const stranger = await openReplica('stranger')
  try {
    await Effect.runPromise(alice.submit(Message.CreatedTodo({ id: 'a', title: 'from alice' })))
    await sync(`${server.url}?token=alice`, alice)

    await Effect.runPromise(bob.submit(Message.CreatedTodo({ id: 'b', title: 'from bob' })))
    await sync(`${server.url}?token=bob`, bob)

    // Alice's write commits under her actor; Bob reads it, but his own write is
    // refused and dropped from his outbox.
    expect(Effect.runSync(alice.shared).todos).toEqual([{ id: 'a', title: 'from alice' }])
    expect(Effect.runSync(bob.shared).todos).toEqual([{ id: 'a', title: 'from alice' }])
    expect(Effect.runSync(bob.pending)).toEqual([])
    expect(journal.read('todos', 0).at(-1)).toMatchObject({ actorId: 'alice' })
    expect(journal.snapshot('todos').model.todos.map(todo => todo.id)).toEqual(['a'])

    // An unknown token is closed before it can exchange.
    await expect(
      Effect.runPromise(
        Effect.provide(stranger.synchronize, layerSocket({ url: server.url, maxRetries: 0 })),
      ),
    ).rejects.toThrow()
    expect(Effect.runSync(stranger.cursor)).toBe(0)
  } finally {
    await Promise.all([alice, bob, stranger].map(replica => Effect.runPromise(replica.close)))
    journal.close()
  }
})
