import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { layerSocket } from 'foldkit-sync'
import { afterEach, describe, expect, it } from 'vitest'
import { Message } from '../src/app.js'
import { openJournal, type SyncPrincipal } from '../src/journal.js'
import { startSyncServer, type SyncServer } from '../src/server.js'
import { closeStorages, openReplica, type TodoReplica } from './helpers.js'

const principal: SyncPrincipal = { actorId: 'owner', documentId: 'todos', canWrite: true }
const servers: Array<SyncServer> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await closeStorages()
})

const sync = (url: string, replica: TodoReplica): Promise<void> =>
  Effect.runPromise(Effect.provide(replica.synchronize, layerSocket({ url })))

describe('the sync server', () => {
  it('converges two replicas over a real WebSocket', async () => {
    const journal = openJournal(':memory:')
    const server = await startSyncServer({ journal, authenticate: () => ({ principal }) })
    servers.push(server)
    const a = await openReplica('a')
    const b = await openReplica('b')
    try {
      await Effect.runPromise(a.submit(Message.SubmittedTodo({ id: 'a', title: 'from a' })))
      await Effect.runPromise(b.submit(Message.SubmittedTodo({ id: 'b', title: 'from b' })))

      // Two passes: each replica pushes its outbox, then catches up on the
      // other's committed operation.
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

  it('replicates a todo the server agent authored', async () => {
    const journal = openJournal(':memory:')
    const server = await startSyncServer({ journal, authenticate: () => ({ principal }) })
    servers.push(server)
    const replica = await openReplica('client')
    try {
      journal.appendAsServer(
        Message.SubmittedTodo({ id: 's1', title: 'from the server agent' }),
        principal,
        'server',
      )

      await sync(server.url, replica)

      expect(Effect.runSync(replica.shared).todos).toEqual([
        { id: 's1', title: 'from the server agent', completed: false },
      ])
    } finally {
      await Effect.runPromise(replica.close)
      journal.close()
    }
  })

  it('persists committed operations to a SQLite file across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foldkit-todo-'))
    const file = join(dir, 'todos.db')
    try {
      const first = openJournal(file)
      first.appendAsServer(
        Message.SubmittedTodo({ id: 'p1', title: 'persisted' }),
        principal,
        'server',
      )
      first.close()

      const second = openJournal(file)
      expect(second.snapshot('todos').model.todos).toEqual([
        { id: 'p1', title: 'persisted', completed: false },
      ])
      second.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
