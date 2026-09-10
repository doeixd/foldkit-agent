import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { indexedDb, layerSocket } from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { Message } from '../src/app.js'
import { openJournal, type Principal } from '../src/journal.js'
import { startSyncServer, type SyncServer } from '../src/server.js'
import { openReplicaEffect, type TodoReplica } from './helpers.js'

const principal: Principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const servers: Array<SyncServer> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

const openReplica = async (id: string): Promise<TodoReplica> =>
  openReplicaEffect(id, await indexedDb(id, new IDBFactory()))

const sync = (url: string, replica: TodoReplica): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerSocket({ url })))

it('converges a replica over a real WebSocket', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({ journal, principal })
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
  const server = await startSyncServer({ journal, principal })
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
