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
 * The principal is fixed at construction; a real deployment authenticates each
 * connection and derives it per socket instead.
 */
export const startSyncServer = async (options: {
  readonly journal: Journal
  readonly principal: Principal
  readonly port?: number
}): Promise<SyncServer> => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const handler = options.journal.transport(options.principal)

  server.on('connection', socket => {
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
