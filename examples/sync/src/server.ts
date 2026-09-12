import { WebSocketServer, type WebSocket } from 'ws'
import {
  sequence,
  servePresence,
  serveSocket,
  type PresenceHub,
  type SocketLike,
} from 'foldkit-sync'
import type { Journal, Principal } from './journal.js'

/** Adapts one `ws` socket to the transport's minimal socket. */
const socketLike = (socket: WebSocket): SocketLike => ({
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
})

export interface SyncServer {
  readonly url: string
  readonly close: () => Promise<void>
}

/** What an accepted token resolves to. An omitted `expiresAt` never expires. */
export interface Authenticated {
  readonly principal: Principal
  /** Epoch milliseconds after which the server closes the connection. */
  readonly expiresAt?: number | undefined
}

/**
 * A local WebSocket server fronting the journal.
 *
 * The principal is derived per connection from the `token` query parameter; a
 * real deployment would validate a bearer token or session cookie instead, and
 * refresh it before it expires.
 */
export const startSyncServer = async <Presence = unknown>(options: {
  readonly journal: Journal
  /** Maps a connection's token to a credential; `undefined` refuses the socket. */
  readonly authenticate: (token: string | null) => Authenticated | undefined
  /** Optional presence registry; a socket joins the hub for its document. */
  readonly presence?: ((documentId: string) => PresenceHub<Presence>) | undefined
  readonly port?: number
}): Promise<SyncServer> => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  server.on('connection', (socket, request) => {
    const token = new URL(request.url ?? '', 'ws://localhost').searchParams.get('token')
    const authenticated = options.authenticate(token)
    if (authenticated === undefined) {
      socket.close(4401, 'Unauthenticated')
      return
    }
    const { principal, expiresAt } = authenticated
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      socket.close(4401, 'Credential expired')
      return
    }
    const expiry =
      expiresAt === undefined
        ? undefined
        : setTimeout(() => socket.close(4401, 'Credential expired'), expiresAt - Date.now())

    const handler = options.journal.transport(principal)
    const stops = [
      serveSocket(socketLike(socket), {
        exchange: (cursor, pending) => handler.exchange(sequence(cursor), pending),
      }),
    ]
    if (options.presence !== undefined)
      stops.push(
        servePresence(socketLike(socket), options.presence(principal.documentId), {
          peerId: principal.actorId,
        }),
      )
    socket.on('close', () => {
      if (expiry !== undefined) clearTimeout(expiry)
      for (const stop of stops) stop()
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      ),
  }
}
