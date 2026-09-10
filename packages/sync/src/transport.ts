import { Context, Duration, Effect, Layer, Schedule, Schema } from 'effect'
import type { Operation, TransportClient } from './sync.js'

/** The wire failure of a transport. A refusal is a result, not an error. */
export class TransportError extends Schema.TaggedError<TransportError>()('SyncTransportError', {
  message: Schema.String,
}) {}

/** One request/response frame, as it crosses a wire. */
export interface ExchangeFrame {
  readonly id: string
  readonly cursor: number
  readonly pending: ReadonlyArray<Operation>
}

export interface ExchangeReply {
  readonly id: string
  readonly result?: unknown
  readonly error?: string
}

export interface TransportShape {
  readonly exchange: (
    cursor: number,
    pending: ReadonlyArray<Operation>,
  ) => Effect.Effect<unknown, TransportError>
}

/**
 * The seam the replica syncs through.
 *
 * A service, not a concrete client, so an application substitutes an in-process
 * transport, a socket, or a test double without the replica knowing. A refusal
 * arrives in the exchange result; only a wire failure is a `TransportError`.
 */
export class Transport extends Context.Service<Transport, TransportShape>()(
  'foldkit-sync/Transport',
) {}

const failure = (error: unknown): TransportError =>
  new TransportError({ message: error instanceof Error ? error.message : String(error) })

/** A transport backed by an in-process handler, for tests and single-process demos. */
export const layerLoopback = (
  handler: (cursor: number, pending: ReadonlyArray<Operation>) => unknown | Promise<unknown>,
): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    exchange: (cursor, pending) =>
      Effect.tryPromise({ try: () => Promise.resolve(handler(cursor, pending)), catch: failure }),
  })

/** Wraps the promise-based client the replica already speaks. */
export const layerFromPromise = (transport: TransportClient): Layer.Layer<Transport> =>
  Layer.succeed(Transport, {
    exchange: (cursor, pending) =>
      Effect.tryPromise({ try: () => transport.exchange(cursor, pending), catch: failure }),
  })

/** Bridges the service back to the promise client the replica consumes. */
export const toPromise = (transport: TransportShape): TransportClient => ({
  exchange: (cursor, pending) => Effect.runPromise(transport.exchange(cursor, pending)),
})

/**
 * Serves one accepted socket, answering each exchange frame.
 *
 * The counterpart to `layerSocket`: the handler returns the exchange result, or
 * throws and the failure is written back as an error frame. Returns a function
 * that stops serving.
 */
export const serveSocket = (
  socket: SocketLike,
  options: {
    readonly exchange: (
      cursor: number,
      pending: ReadonlyArray<Operation>,
    ) => unknown | Promise<unknown>
  },
): (() => void) => {
  const send = (reply: ExchangeReply): void => {
    try {
      socket.send(JSON.stringify(reply))
    } catch {
      // The socket may have closed while the handler was running.
    }
  }
  const stopMessage = socket.onMessage(data => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const { id, cursor, pending } = parsed as { id?: unknown; cursor?: unknown; pending?: unknown }
    // Without an id there is nobody to answer, so drop the frame.
    if (typeof id !== 'string') return
    if (
      typeof cursor !== 'number' ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Array.isArray(pending)
    ) {
      send({ id, error: 'Invalid exchange frame' })
      return
    }
    const frame: ExchangeFrame = { id, cursor, pending: pending as ReadonlyArray<Operation> }
    void (async () => {
      try {
        const result = await options.exchange(frame.cursor, frame.pending)
        send({ id: frame.id, result })
      } catch (error) {
        send({ id: frame.id, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
  const stopClose = socket.onClose(() => stopMessage())
  return () => {
    stopMessage()
    stopClose()
  }
}

/** The minimal socket the layer needs; the global `WebSocket` satisfies it. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onMessage(listener: (data: string) => void): () => void
  onClose(listener: () => void): () => void
  /**
   * Optional. When provided, exchanges wait for it before sending, so a
   * transport can connect asynchronously. Absent means already connected.
   */
  onOpen?(listener: () => void): () => void
}

export interface SocketOptions {
  readonly url: string
  /** Injectable for tests; defaults to the platform `WebSocket`. */
  readonly makeSocket?: ((url: string) => SocketLike) | undefined
  /** Reconnect attempts after a close before queued work fails. Default 5. */
  readonly maxRetries?: number | undefined
  /** Base delay of the exponential reconnect backoff. Default `50 millis`. */
  readonly retryBase?: Duration.Input | undefined
  /** Exchanges queued or in flight before new ones fail. Default 64. */
  readonly maxQueue?: number | undefined
}

/** The default socket factory: the platform `WebSocket`, as a `SocketLike`. */
export const nativeSocket = (url: string): SocketLike => {
  const socket = new WebSocket(url)
  return {
    send: data => socket.send(data),
    close: () => socket.close(),
    onOpen: listener => {
      if (socket.readyState === WebSocket.OPEN) {
        listener()
        return () => {}
      }
      socket.addEventListener('open', listener)
      return () => socket.removeEventListener('open', listener)
    },
    onMessage: listener => {
      const handler = (event: MessageEvent): void => listener(String(event.data))
      socket.addEventListener('message', handler)
      return () => socket.removeEventListener('message', handler)
    },
    onClose: listener => {
      const handler = (): void => listener()
      socket.addEventListener('close', handler)
      return () => socket.removeEventListener('close', handler)
    },
  }
}

/**
 * A WebSocket client transport.
 *
 * One connection is live at a time. While it is connecting, exchanges queue; if
 * it closes, the transport reconnects on an exponential, jittered backoff and
 * re-sends every queued and in-flight frame with its original id, so a lost
 * reply is answered rather than dropped and a late reply cannot resolve a newer
 * frame. Once the retries are exhausted (or the layer closes) queued work fails
 * with a `TransportError`; a queue over `maxQueue` fails new exchanges with
 * backpressure. The socket is released when the layer's scope ends.
 */
export const layerSocket = (options: SocketOptions): Layer.Layer<Transport, TransportError> =>
  Layer.effect(
    Transport,
    Effect.gen(function* () {
      const makeSocket = options.makeSocket ?? nativeSocket
      const maxQueue = options.maxQueue ?? 64
      const retry = Schedule.exponential(options.retryBase ?? '50 millis').pipe(
        Schedule.jittered,
        Schedule.upTo({ times: options.maxRetries ?? 5 }),
      )

      interface Entry {
        readonly id: string
        readonly cursor: number
        readonly pending: ReadonlyArray<Operation>
        readonly resume: (effect: Effect.Effect<unknown, TransportError>) => void
      }
      const queued: Array<Entry> = []
      const inFlight = new Map<string, Entry>()
      let socket: SocketLike | undefined
      let ready = false
      let nextId = 0
      let disposed = false

      const send = (entry: Entry): void => {
        inFlight.set(entry.id, entry)
        socket?.send(
          JSON.stringify({
            id: entry.id,
            cursor: entry.cursor,
            pending: entry.pending,
          } satisfies ExchangeFrame),
        )
      }
      const flush = (): void => {
        if (socket === undefined || !ready) return
        for (const entry of queued.splice(0)) send(entry)
      }
      const requeue = (): void => {
        queued.unshift(...inFlight.values())
        inFlight.clear()
      }
      const failAll = (message: string): void => {
        const entries = [...queued.splice(0), ...inFlight.values()]
        inFlight.clear()
        for (const entry of entries) entry.resume(Effect.fail(new TransportError({ message })))
      }

      const connect = Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            const next = makeSocket(options.url)
            socket = next
            ready = next.onOpen === undefined
            const offOpen = next.onOpen?.(() => {
              ready = true
              flush()
            })
            const offMessage = next.onMessage(data => {
              let reply: ExchangeReply
              try {
                reply = JSON.parse(data) as ExchangeReply
              } catch {
                return
              }
              const entry = inFlight.get(reply.id)
              if (entry === undefined) return
              inFlight.delete(reply.id)
              entry.resume(
                reply.error === undefined
                  ? Effect.succeed(reply.result)
                  : Effect.fail(new TransportError({ message: reply.error })),
              )
            })
            const offClose = next.onClose(() => {
              offOpen?.()
              offMessage()
              offClose()
              socket = undefined
              ready = false
              // Keep every unanswered frame for the next connection.
              requeue()
              reject(new Error('transport closed'))
            })
            if (ready) flush()
          }),
        catch: () => new TransportError({ message: 'transport closed' }),
      })

      yield* Effect.forkScoped(
        connect.pipe(
          Effect.retry(retry),
          Effect.catch(error =>
            Effect.sync(() => {
              if (!disposed) failAll(error.message)
            }),
          ),
        ),
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposed = true
          ready = false
          socket?.close()
          socket = undefined
          failAll('transport closed')
        }),
      )

      return {
        exchange: (cursor, pending) =>
          Effect.callback<unknown, TransportError>(resume => {
            if (disposed) {
              resume(Effect.fail(new TransportError({ message: 'transport closed' })))
              return
            }
            if (queued.length + inFlight.size >= maxQueue) {
              resume(Effect.fail(new TransportError({ message: 'transport queue full' })))
              return
            }
            const entry: Entry = { id: String(nextId++), cursor, pending, resume }
            if (ready) send(entry)
            else queued.push(entry)
          }),
      }
    }),
  )
