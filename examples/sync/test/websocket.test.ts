import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { indexedDb, layerSocket, toPromise, Transport, type Replica } from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { Message, type Shared } from '../src/app.js'
import { openJournal, type Principal } from '../src/journal.js'
import { startSyncServer, type SyncServer } from '../src/server.js'
import { Sync } from '../src/sync.js'

const principal: Principal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const servers: Array<SyncServer> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

const openReplica = async (id: string): Promise<Replica<Message, Shared>> =>
  Sync.openReplica(id, await indexedDb(id, new IDBFactory()))

const sync = (url: string, replica: Replica<Message, Shared>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Effect.service(Transport)
      yield* Effect.promise(() => replica.synchronize(toPromise(service)))
    }).pipe(Effect.provide(layerSocket({ url }))),
  )

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

    expect(replica.cursor()).toBe(1)
    expect(replica.shared().todos).toEqual([{ id: 'a', title: 'over the wire' }])
  } finally {
    replica.close()
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
    await a.submit(Message.CreatedTodo({ id: 'a', title: 'from a' }))
    await b.submit(Message.CreatedTodo({ id: 'b', title: 'from b' }))

    await Promise.all([sync(server.url, a), sync(server.url, b)])
    await Promise.all([sync(server.url, a), sync(server.url, b)])

    expect(a.shared()).toEqual(b.shared())
    expect(
      a
        .shared()
        .todos.map(todo => todo.id)
        .sort(),
    ).toEqual(['a', 'b'])
  } finally {
    a.close()
    b.close()
    journal.close()
  }
})
