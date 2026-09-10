import { describe, expect, it } from 'vitest'
import { createPresence, loopbackPresenceChannel } from '../src/index.js'

interface Cursor {
  readonly cursor: number
}

describe('presence', () => {
  it('expires a peer that stops refreshing after its ttl', () => {
    let clock = 0
    const presence = createPresence<Cursor>({ id: 'a', ttl: 100, now: () => clock })

    presence.set({ cursor: 1 })
    expect(presence.peers()).toHaveLength(1)

    clock = 100
    expect(presence.peers()).toHaveLength(1)

    clock = 101
    expect(presence.peers()).toEqual([])
  })

  it('prunes expired peers and notifies only when something went', () => {
    let clock = 0
    const presence = createPresence<Cursor>({ id: 'a', ttl: 100, now: () => clock })
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
    const a = createPresence<Cursor>({ id: 'a', ttl: 100, channel, now: () => clock })
    const b = createPresence<Cursor>({ id: 'b', ttl: 100, channel, now: () => clock })

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
    const a = createPresence<Cursor>({ id: 'a', ttl: 100, channel })
    const b = createPresence<Cursor>({ id: 'b', ttl: 100, channel })
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
    const a = createPresence<Cursor>({ id: 'a', ttl: 100, channel })
    const b = createPresence<Cursor>({ id: 'b', ttl: 100, channel })

    b.close()
    a.set({ cursor: 9 })
    expect(b.peers()).toEqual([])
  })
})
