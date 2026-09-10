import type { SocketLike } from '../src/index.js'

/** Two connected fake sockets, so a transport or presence channel can be driven. */
export const socketPair = (): { client: SocketLike; server: SocketLike } => {
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
