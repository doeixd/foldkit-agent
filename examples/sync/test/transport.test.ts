import { Effect } from 'effect'
import { IDBFactory } from 'fake-indexeddb'
import { layerSocket, sequence, serveSocket, type SocketLike } from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { Message } from '../src/app.js'
import { openJournal, type Principal } from '../src/journal.js'
import { closeStorages, openReplicaEffect, openStorage } from './helpers.js'

afterEach(closeStorages)

const principal: Principal = { actorId: 'owner', documentId: 'todos', canWrite: true }

/** Two connected fake sockets, so the whole wire path runs without a server. */
const socketPair = (): { client: SocketLike; server: SocketLike } => {
  const clientMessages = new Set<(data: string) => void>()
  const serverMessages = new Set<(data: string) => void>()
  const clientCloses = new Set<() => void>()
  const client: SocketLike = {
    send: data => {
      for (const listener of [...serverMessages]) listener(data)
    },
    close: () => {
      for (const listener of [...clientCloses]) listener()
    },
    onMessage: listener => {
      clientMessages.add(listener)
      return () => clientMessages.delete(listener)
    },
    onClose: listener => {
      clientCloses.add(listener)
      return () => clientCloses.delete(listener)
    },
  }
  const server: SocketLike = {
    send: data => {
      for (const listener of [...clientMessages]) listener(data)
    },
    close: () => {},
    onMessage: listener => {
      serverMessages.add(listener)
      return () => serverMessages.delete(listener)
    },
    onClose: () => () => {},
  }
  return { client, server }
}

it('converges a replica through the socket transport', async () => {
  const journal = openJournal(':memory:')
  const { client, server } = socketPair()
  const handler = journal.transport(principal)
  serveSocket(server, {
    exchange: (cursor, pending) => handler.exchange(sequence(cursor), pending),
  })
  const replica = await openReplicaEffect(
    'browser',
    await Effect.runPromise(openStorage('browser', new IDBFactory())),
  )
  try {
    // A server-side producer commits one operation the client has not seen.
    journal.appendAsServer(
      Message.CreatedTodo({ id: 'a', title: 'from the wire' }),
      principal,
      'server',
    )

    await Effect.runPromise(
      Effect.provide(
        replica.synchronize,
        layerSocket({ url: 'ws://test', makeSocket: () => client }),
      ),
    )

    expect(Effect.runSync(replica.cursor)).toBe(1)
    expect(Effect.runSync(replica.shared).todos).toEqual([{ id: 'a', title: 'from the wire' }])
  } finally {
    await Effect.runPromise(replica.close)
    journal.close()
  }
})
