import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  createPresence,
  createPresenceHub,
  loopbackPresenceChannel,
  servePresence,
  socketPresenceChannel,
  type PresenceOptions,
} from '../src/index.js'
import { socketPair } from './sockets.js'

interface Cursor {
  readonly cursor: number
}

const decodeCursor = Schema.decodeUnknownSync(Schema.Struct({ cursor: Schema.Number }))
const make = (options: Omit<PresenceOptions<Cursor>, 'decodeValue'>) =>
  createPresence<Cursor>({ decodeValue: decodeCursor, ...options })

describe('presence', () => {
  it('expires a peer that stops refreshing after its ttl', () => {
    let clock = 0
    const presence = make({ id: 'a', ttl: 100, now: () => clock })

    presence.set({ cursor: 1 })
    expect(presence.peers()).toHaveLength(1)

    clock = 100
    expect(presence.peers()).toHaveLength(1)

    clock = 101
    expect(presence.peers()).toEqual([])
  })

  it('keeps a peer live while it refreshes before the ttl', () => {
    let clock = 0
    const presence = make({ id: 'a', ttl: 100, now: () => clock })

    presence.set({ cursor: 1 })
    clock = 90
    presence.set({ cursor: 2 })

    clock = 150
    expect(presence.peers()).toEqual([{ id: 'a', value: { cursor: 2 }, updatedAt: 90 }])

    clock = 191
    expect(presence.peers()).toEqual([])
  })

  it('prunes expired peers and notifies only when something went', () => {
    let clock = 0
    const presence = make({ id: 'a', ttl: 100, now: () => clock })
    let notifications = 0
    presence.subscribe(() => {
      notifications += 1
    })

    presence.set({ cursor: 1 })
    expect(notifications).toBe(1)

    clock = 50
    presence.prune()
    expect(notifications).toBe(1)

    clock = 101
    presence.prune()
    expect(notifications).toBe(2)
  })

  it('broadcasts to other peers over the channel and drops a departure', () => {
    let clock = 0
    const channel = loopbackPresenceChannel<Cursor>()
    const a = make({ id: 'a', ttl: 100, channel, now: () => clock })
    const b = make({ id: 'b', ttl: 100, channel, now: () => clock })

    a.set({ cursor: 3 })
    expect(b.peers()).toEqual([{ id: 'a', value: { cursor: 3 }, updatedAt: 0 }])

    b.set({ cursor: 5 })
    expect(a.peers().map(peer => peer.id)).toEqual(['a', 'b'])

    a.leave()
    expect(a.peers().map(peer => peer.id)).toEqual(['b'])
    expect(b.peers().map(peer => peer.id)).toEqual(['b'])
  })

  it('notifies subscribers, stops on unsubscribe, and survives a throwing one', () => {
    const channel = loopbackPresenceChannel<Cursor>()
    const a = make({ id: 'a', ttl: 100, channel })
    const b = make({ id: 'b', ttl: 100, channel })
    b.subscribe(() => {
      throw new Error('subscriber failed')
    })
    let notifications = 0
    const stop = b.subscribe(() => {
      notifications += 1
    })

    expect(() => a.set({ cursor: 1 })).not.toThrow()
    expect(notifications).toBe(1)

    stop()
    a.set({ cursor: 2 })
    expect(notifications).toBe(1)
  })

  it('stops receiving once closed', () => {
    const channel = loopbackPresenceChannel<Cursor>()
    const a = make({ id: 'a', ttl: 100, channel })
    const b = make({ id: 'b', ttl: 100, channel })

    b.close()
    a.set({ cursor: 9 })
    expect(b.peers()).toEqual([])
  })

  it('carries presence between peers through a hub over sockets', () => {
    const hub = createPresenceHub<Cursor>()
    const a = socketPair()
    const b = socketPair()
    servePresence(a.server, hub)
    servePresence(b.server, hub)

    const presenceA = make({
      id: 'a',
      ttl: 100,
      channel: socketPresenceChannel(a.client),
    })
    const presenceB = make({
      id: 'b',
      ttl: 100,
      channel: socketPresenceChannel(b.client),
    })

    presenceA.set({ cursor: 1 })
    expect(presenceB.peers().map(peer => [peer.id, peer.value.cursor])).toEqual([['a', 1]])

    presenceA.leave()
    expect(presenceB.peers()).toEqual([])

    presenceA.close()
    presenceB.close()
  })

  it('ignores messages that are not presence updates', () => {
    const hub = createPresenceHub<Cursor>()
    const { client, server } = socketPair()
    const seen: Array<unknown> = []
    hub.join(update => seen.push(update))
    servePresence(server, hub)

    client.send('not json')
    client.send(JSON.stringify({ id: 'x', cursor: 0, pending: [] }))

    expect(seen).toEqual([])
  })

  it('delivers to every peer when one send throws', () => {
    const hub = createPresenceHub<Cursor>()
    const seen: Array<string> = []
    hub.join(() => {
      throw new Error('dead socket')
    })
    hub.join(update => seen.push(update.id))

    hub.publish({ id: 'a', value: { cursor: 1 } })

    expect(seen).toEqual(['a'])
  })

  it('drops a peer value that fails the contract', () => {
    const channel = loopbackPresenceChannel<Cursor>()
    const b = make({ id: 'b', ttl: 100, channel })

    // A hostile peer bypasses the typed publish with a wrong-shaped value.
    channel.publish({ id: 'a', value: { cursor: 'not a number' } as unknown as Cursor })

    expect(b.peers()).toEqual([])
  })
})
