import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  layerFromPromise,
  layerLoopback,
  layerSocket,
  nativeSocket,
  serveSocket,
  toPromise,
  Transport,
  type SocketLike,
} from '../src/index.js'
import { socketPair } from './sockets.js'

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

  it('refuses a frame it cannot answer before the handler sees it', async () => {
    const { client, server } = socketPair()
    let exchanged = 0
    serveSocket(server, {
      exchange: () => {
        exchanged += 1
        return { operations: [], rejected: [] }
      },
    })

    client.send('not json')
    client.send(JSON.stringify({ id: 'x', cursor: 'nope', pending: [] }))
    client.send(JSON.stringify({ cursor: 0, pending: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(exchanged).toBe(0)
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

  it('does not leak an unhandled rejection when the reply cannot be sent', async () => {
    const { client, server } = socketPair()
    const refusing: SocketLike = {
      ...server,
      send: () => {
        throw new Error('socket closed')
      },
    }
    let exchanged = false
    serveSocket(refusing, {
      exchange: () => {
        exchanged = true
        return { operations: [], rejected: [] }
      },
    })

    const rejections: Array<unknown> = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      client.send(JSON.stringify({ id: '1', cursor: 0, pending: [] }))
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(exchanged).toBe(true)
    expect(rejections).toEqual([])
  })

  it('fails an exchange queued before the socket opens if it closes first', async () => {
    const closes = new Set<() => void>()
    let opened: () => void = () => {}
    const built = new Promise<void>(resolve => {
      opened = resolve
    })
    const client: SocketLike = {
      send: () => {},
      close: () => {
        for (const listener of [...closes]) listener()
      },
      onOpen: () => {
        opened()
        return () => {}
      },
      onMessage: () => () => {},
      onClose: listener => {
        closes.add(listener)
        return () => closes.delete(listener)
      },
    }

    const running = Effect.runPromise(withSocket(client))
    await built
    // Let the fiber queue its exchange against the still-connecting socket.
    await new Promise(resolve => setTimeout(resolve, 0))
    client.close()

    expect(await running).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'transport closed' },
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

describe('the default socket', () => {
  it('removes the close listener it registers', () => {
    class FakeSocket {
      static readonly OPEN = 1
      static readonly instances: FakeSocket[] = []
      readyState = 0
      private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
      constructor() {
        FakeSocket.instances.push(this)
      }
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const set = this.listeners.get(type) ?? new Set()
        set.add(listener)
        this.listeners.set(type, set)
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.get(type)?.delete(listener)
      }
      emit(type: string): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener({})
      }
      send(): void {}
      close(): void {}
    }

    vi.stubGlobal('WebSocket', FakeSocket)
    try {
      const socket = nativeSocket('ws://test')
      const instance = FakeSocket.instances[0]!
      const listener = vi.fn()
      const off = socket.onClose(listener)

      instance.emit('close')
      expect(listener).toHaveBeenCalledTimes(1)

      off()
      instance.emit('close')
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
