import { Clock, Effect, Layer, Schema, type Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { WebSocket as WsClient } from 'ws'
import {
  createPresence,
  createPresenceHub,
  socketPresenceChannel,
  type Presence,
  type PresenceHub,
  type SocketLike,
} from 'foldkit-sync'
import { afterEach, expect, it } from 'vitest'
import { openJournal, type Principal } from '../src/journal.js'
import { startSyncServer, type Authenticated, type SyncServer } from '../src/server.js'

const accounts: Record<string, Principal> = {
  alice: { actorId: 'alice', documentId: 'todos', canWrite: true },
  bob: { actorId: 'bob', documentId: 'todos', canWrite: true },
  carol: { actorId: 'carol', documentId: 'other', canWrite: true },
}
const authenticate = (token: string | null): Authenticated | undefined => {
  if (token === null) return undefined
  const account = accounts[token]
  return account === undefined ? undefined : { principal: account }
}

/** One hub per document, so presence cannot cross a document boundary. */
const createPresenceRegistry = (): ((documentId: string) => PresenceHub<Selection>) => {
  const hubs = new Map<string, PresenceHub<Selection>>()
  return documentId => {
    const existing = hubs.get(documentId)
    if (existing !== undefined) return existing
    const hub = createPresenceHub<Selection>()
    hubs.set(documentId, hub)
    return hub
  }
}

const Selection = Schema.Struct({ selectedTodoId: Schema.String })
type Selection = typeof Selection.Type
const decodeSelection = Schema.decodeUnknownSync(Selection)

const sockets: Array<WsClient> = []
const servers: Array<SyncServer> = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(servers.splice(0).map(server => server.close()))
})

const connect = (url: string): Promise<SocketLike> =>
  new Promise((resolve, reject) => {
    const socket = new WsClient(url)
    sockets.push(socket)
    socket.once('open', () =>
      resolve({
        send: data => socket.send(data),
        close: () => socket.close(),
        onMessage: listener => {
          const handler = (data: unknown): void => listener(String(data))
          socket.on('message', handler)
          return () => socket.off('message', handler)
        },
        onClose: listener => {
          socket.on('close', listener)
          return () => socket.off('close', listener)
        },
      }),
    )
    socket.once('error', reject)
  })

/**
 * A `TestClock` keeps the TTL deterministic. The casts cover the pinned Effect
 * rc: `provide` does not narrow `Clock` out of a `Clock | Scope` requirement, so
 * `Effect.scoped` still sees it.
 */
const run = (program: Effect.Effect<void, never, Clock.Clock | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        TestClock.layer() as unknown as Layer.Layer<Clock.Clock>,
      ) as Effect.Effect<void, never, Scope.Scope>,
    ),
  )

/** Real sockets deliver asynchronously; poll with real time, not the frozen `TestClock`. */
const waitForPeer = <Update>(
  presence: Presence<Update>,
  id: string,
  matches: (value: Update) => boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const peers = yield* presence.peers
      const peer = peers.find(candidate => candidate.id === id)
      if (peer !== undefined && matches(peer.value)) return
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 10)))
    }
    yield* Effect.die(new Error(`Timed out waiting for ${id}`))
  })

it('broadcasts presence between two authenticated peers over the socket', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({
    journal,
    authenticate,
    presence: createPresenceRegistry(),
  })
  servers.push(server)

  const aliceSocket = await connect(`${server.url}?token=alice`)
  const bobSocket = await connect(`${server.url}?token=bob`)

  try {
    await run(
      Effect.gen(function* () {
        const alice = yield* createPresence<Selection>({
          id: 'alice',
          ttl: '5 seconds',
          channel: yield* socketPresenceChannel<Selection>(aliceSocket),
          decodeValue: decodeSelection,
        })
        const bob = yield* createPresence<Selection>({
          id: 'bob',
          ttl: '5 seconds',
          channel: yield* socketPresenceChannel<Selection>(bobSocket),
          decodeValue: decodeSelection,
        })

        // Let both channel consumers subscribe before anything is published; an
        // unbounded PubSub drops a message that has no subscriber yet.
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        yield* alice.set({ selectedTodoId: 'a' })
        yield* waitForPeer(bob, 'alice', value => value.selectedTodoId === 'a')

        yield* bob.set({ selectedTodoId: 'b' })
        yield* waitForPeer(alice, 'bob', value => value.selectedTodoId === 'b')
      }),
    )
  } finally {
    journal.close()
  }
})

it('does not broadcast presence across document boundaries', async () => {
  const journal = openJournal(':memory:')
  const server = await startSyncServer({
    journal,
    authenticate,
    presence: createPresenceRegistry(),
  })
  servers.push(server)

  const aliceSocket = await connect(`${server.url}?token=alice`)
  const carolSocket = await connect(`${server.url}?token=carol`)

  try {
    await run(
      Effect.gen(function* () {
        const alice = yield* createPresence<Selection>({
          id: 'alice',
          ttl: '5 seconds',
          channel: yield* socketPresenceChannel<Selection>(aliceSocket),
          decodeValue: decodeSelection,
        })
        const carol = yield* createPresence<Selection>({
          id: 'carol',
          ttl: '5 seconds',
          channel: yield* socketPresenceChannel<Selection>(carolSocket),
          decodeValue: decodeSelection,
        })
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        yield* alice.set({ selectedTodoId: 'a' })
        // Give a leaked frame time to arrive before asserting isolation.
        yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 50)))
        expect(yield* carol.peers).toEqual([])
      }),
    )
  } finally {
    journal.close()
  }
})
