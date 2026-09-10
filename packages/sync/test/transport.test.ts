import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  layerFromPromise,
  layerLoopback,
  layerSocket,
  serveSocket,
  toPromise,
  Transport,
  type SocketLike,
} from '../src/index.js'

const exchange = Effect.gen(function* () {
  const transport = yield* Effect.service(Transport)
  return yield* transport.exchange(0, [])
}).pipe(Effect.result)

describe('the transport service', () => {
  it('provides an in-process loopback layer', async () => {
    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      return yield* transport.exchange(3, [])
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layerLoopback((cursor, pending) => ({ cursor, pending })))),
    )

    expect(result).toEqual({ cursor: 3, pending: [] })
  })

  it('wraps a throwing handler as a transport error', async () => {
    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      return yield* transport.exchange(0, [])
    }).pipe(Effect.result)

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          layerLoopback(() => {
            throw new Error('down')
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'down' },
    })
  })

  it('wraps a promise client and bridges back to one', async () => {
    const promise = layerFromPromise({ exchange: async (cursor: number) => ({ cursor }) })
    expect(await Effect.runPromise(exchange.pipe(Effect.provide(promise)))).toMatchObject({
      _tag: 'Success',
      success: { cursor: 0 },
    })

    expect(
      await toPromise({ exchange: cursor => Effect.succeed({ cursor }) }).exchange(4, []),
    ).toEqual({ cursor: 4 })
  })
})

/** Two connected sockets, so the layer can be driven without a server. */
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

const withSocket = (client: SocketLike) =>
  exchange.pipe(Effect.provide(layerSocket({ url: 'ws://test', makeSocket: () => client })))

describe('the socket transport', () => {
  it('sends one frame and resolves the matching reply', async () => {
    const { client, server } = socketPair()
    server.onMessage(data => {
      const frame = JSON.parse(data) as { id: string }
      server.send(JSON.stringify({ id: frame.id, result: { operations: [], rejected: [] } }))
    })

    expect(await Effect.runPromise(withSocket(client))).toMatchObject({
      _tag: 'Success',
      success: { operations: [], rejected: [] },
    })
  })

  it('fails the exchange when the reply carries an error', async () => {
    const { client, server } = socketPair()
    server.onMessage(data => {
      const frame = JSON.parse(data) as { id: string }
      server.send(JSON.stringify({ id: frame.id, error: 'refused' }))
    })

    expect(await Effect.runPromise(withSocket(client))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'refused' },
    })
  })

  it('correlates concurrent exchanges by frame id', async () => {
    const { client, server } = socketPair()
    const frames: Array<{ id: string }> = []
    server.onMessage(data => {
      const frame = JSON.parse(data) as { id: string }
      frames.push(frame)
      if (frames.length === 2) {
        // Reply in reverse order; the layer must match each id, not arrival.
        server.send(JSON.stringify({ id: frames[1]!.id, result: 'second' }))
        server.send(JSON.stringify({ id: frames[0]!.id, result: 'first' }))
      }
    })

    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      return yield* Effect.all([transport.exchange(1, []), transport.exchange(2, [])], {
        concurrency: 'unbounded',
      })
    })

    expect(
      await Effect.runPromise(
        program.pipe(Effect.provide(layerSocket({ url: 'ws://test', makeSocket: () => client }))),
      ),
    ).toEqual(['first', 'second'])
  })

  it('answers the client when the far socket is served', async () => {
    const { client, server } = socketPair()
    serveSocket(server, { exchange: (cursor, pending) => ({ cursor, pending }) })

    expect(await Effect.runPromise(withSocket(client))).toMatchObject({
      _tag: 'Success',
      success: { cursor: 0, pending: [] },
    })
  })

  it('returns a handler failure to the client as a transport error', async () => {
    const { client, server } = socketPair()
    serveSocket(server, {
      exchange: () => {
        throw new Error('handler down')
      },
    })

    expect(await Effect.runPromise(withSocket(client))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'handler down' },
    })
  })

  it('fails pending exchanges when the socket closes', async () => {
    const { client, server } = socketPair()
    let received: () => void = () => {}
    const sent = new Promise<void>(resolve => {
      received = resolve
    })
    server.onMessage(() => received())

    const running = Effect.runPromise(withSocket(client))
    await sent
    client.close()

    expect(await running).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'transport closed' },
    })
  })
})
