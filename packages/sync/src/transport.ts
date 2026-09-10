import { Context, Effect, Layer, Schema } from 'effect'
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
    let frame: ExchangeFrame
    try {
      frame = JSON.parse(data) as ExchangeFrame
    } catch {
      return
    }
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
 * Each exchange sends one JSON frame and waits for the reply with the matching
 * id; a reply error or the socket closing fails the exchange. The socket is
 * released when the layer's scope ends.
 */
export const layerSocket = (options: SocketOptions): Layer.Layer<Transport, TransportError> =>
  Layer.effect(
    Transport,
    Effect.acquireRelease(
      Effect.sync(() => (options.makeSocket ?? nativeSocket)(options.url)),
      socket => Effect.sync(() => socket.close()),
    ).pipe(
      Effect.map(socket => {
        const pending = new Map<string, (effect: Effect.Effect<unknown, TransportError>) => void>()
        let nextId = 0
        // A connecting socket cannot send yet; hold exchanges until it opens,
        // and fail them if it closes first instead of leaving them hanging.
        const queued: Array<(error?: string) => void> = []
        let ready = socket.onOpen === undefined
        const offOpen = socket.onOpen?.(() => {
          ready = true
          for (const send of queued.splice(0)) send()
        })
        socket.onMessage(data => {
          let reply: ExchangeReply
          try {
            reply = JSON.parse(data) as ExchangeReply
          } catch {
            return
          }
          const resume = pending.get(reply.id)
          if (resume === undefined) return
          pending.delete(reply.id)
          resume(
            reply.error === undefined
              ? Effect.succeed(reply.result)
              : Effect.fail(new TransportError({ message: reply.error })),
          )
        })
        socket.onClose(() => {
          offOpen?.()
          for (const send of queued.splice(0)) send('transport closed')
          for (const [id, resume] of pending) {
            pending.delete(id)
            resume(Effect.fail(new TransportError({ message: 'transport closed' })))
          }
        })
        return {
          exchange: (cursor, pendingOps) =>
            Effect.callback<unknown, TransportError>(resume => {
              const send = (error?: string): void => {
                if (error !== undefined) {
                  resume(Effect.fail(new TransportError({ message: error })))
                  return
                }
                const id = String(nextId++)
                pending.set(id, resume)
                socket.send(
                  JSON.stringify({ id, cursor, pending: pendingOps } satisfies ExchangeFrame),
                )
              }
              if (ready) send()
              else queued.push(send)
            }),
        }
      }),
    ),
  )
