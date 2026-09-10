import { WebSocketServer, type WebSocket } from 'ws'
import { serveSocket, type SocketLike } from 'foldkit-sync'
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

/**
 * A local WebSocket server fronting the journal.
 *
 * The principal is derived per connection from the `token` query parameter; a
 * real deployment would validate a bearer token or session cookie instead.
 */
export const startSyncServer = async (options: {
  readonly journal: Journal
  /** Maps a connection's token to a principal; `undefined` refuses the socket. */
  readonly authenticate: (token: string | null) => Principal | undefined
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
    const principal = options.authenticate(token)
    if (principal === undefined) {
      socket.close(4401, 'Unauthenticated')
      return
    }
    const handler = options.journal.transport(principal)
    const stop = serveSocket(socketLike(socket), {
      exchange: (cursor, pending) => handler.exchange(cursor, pending),
    })
    socket.on('close', stop)
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error === undefined ? resolve() : reject(error))),
      ),
  }
}
