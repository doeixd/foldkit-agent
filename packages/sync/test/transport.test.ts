import { Effect, Fiber } from 'effect'
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

  it('reconnects and re-sends an exchange after the socket closes', async () => {
    const serverMessages = new Set<(data: string) => void>()
    const replies = new Map<SocketLike, (data: string) => void>()
    let current: SocketLike | undefined
    let clients = 0
    const makeClient = (): SocketLike => {
      clients += 1
      const closes = new Set<() => void>()
      let closed = false
      const client: SocketLike = {
        send: data => {
          if (!closed) for (const listener of [...serverMessages]) listener(data)
        },
        close: () => {
          closed = true
          for (const listener of [...closes]) listener()
        },
        onMessage: listener => {
          const reply = (data: string): void => listener(data)
          replies.set(client, reply)
          return () => replies.delete(client)
        },
        onClose: listener => {
          closes.add(listener)
          return () => closes.delete(listener)
        },
      }
      current = client
      return client
    }
    serverMessages.add(data => {
      const frame = JSON.parse(data) as { id: string }
      replies.get(current!)?.(JSON.stringify({ id: frame.id, result: { ok: true } }))
    })

    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      const first = yield* transport.exchange(0, [])
      current!.close()
      const second = yield* transport.exchange(1, [])
      return [first, second]
    })
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          layerSocket({ url: 'ws://test', makeSocket: makeClient, retryBase: '1 millis' }),
        ),
      ),
    )

    expect(result).toEqual([{ ok: true }, { ok: true }])
    expect(clients).toBe(2)
  })

  it('fails queued work once reconnect attempts are exhausted', async () => {
    let created = 0
    const makeClosing = (): SocketLike => {
      created += 1
      const closes = new Set<() => void>()
      const fire = (): void => {
        for (const listener of [...closes]) listener()
      }
      return {
        send: fire,
        close: fire,
        onMessage: () => () => {},
        onClose: listener => {
          closes.add(listener)
          return () => closes.delete(listener)
        },
      }
    }

    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      return yield* transport.exchange(0, [])
    }).pipe(Effect.result)
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          layerSocket({
            url: 'ws://test',
            makeSocket: makeClosing,
            retryBase: '1 millis',
            maxRetries: 2,
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'transport closed' },
    })
    expect(created).toBe(3)
  })

  it('fails a new exchange when the queue is full', async () => {
    const neverReplies: SocketLike = {
      send: () => {},
      close: () => {},
      onMessage: () => () => {},
      onClose: () => () => {},
    }
    const program = Effect.gen(function* () {
      const transport = yield* Effect.service(Transport)
      const held = yield* Effect.forkScoped(transport.exchange(0, []))
      yield* Effect.yieldNow
      const second = yield* Effect.result(transport.exchange(1, []))
      yield* Fiber.interrupt(held)
      return second
    })
    const result = await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            layerSocket({ url: 'ws://test', makeSocket: () => neverReplies, maxQueue: 1 }),
          ),
        ),
      ),
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'SyncTransportError', message: 'transport queue full' },
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
