/** One peer's presence. A `null` value means the peer left. */
export interface PresenceUpdate<Update> {
  readonly id: string
  readonly value: Update | null
}

/**
 * The ephemeral channel presence travels on.
 *
 * Deliberately not the durable transport: presence is broadcast, never
 * journaled, so a dropped or duplicated update is harmless.
 */
export interface PresenceChannel<Update> {
  publish(update: PresenceUpdate<Update>): void
  subscribe(listener: (update: PresenceUpdate<Update>) => void): () => void
}

export interface PresenceOptions<Update> {
  /** This peer's identity on the channel. */
  readonly id: string
  /** Milliseconds without an update before a peer is dropped. */
  readonly ttl: number
  readonly channel?: PresenceChannel<Update> | undefined
  /** Injectable clock, for tests. */
  readonly now?: (() => number) | undefined
}

export interface PresencePeer<Update> {
  readonly id: string
  readonly value: Update
  readonly updatedAt: number
}

export interface Presence<Update> {
  /** Sets this peer's value and broadcasts it. */
  set(value: Update): void
  /** Removes this peer and broadcasts the departure. */
  leave(): void
  /** Live peers, self included, with stale ones excluded. */
  peers(): ReadonlyArray<PresencePeer<Update>>
  /** Drops expired peers; notifies if any went. */
  prune(): void
  subscribe(listener: () => void): () => void
  /** Stops listening to the channel. */
  close(): void
}

/**
 * Tracks ephemeral peers with a time-to-live.
 *
 * Nothing here touches the durable log: presence is state a peer refreshes, and
 * a peer that stops refreshing is dropped, not replayed.
 */
export const createPresence = <Update>(options: PresenceOptions<Update>): Presence<Update> => {
  const now = options.now ?? (() => Date.now())
  const peers = new Map<string, PresencePeer<Update>>()
  const listeners = new Set<() => void>()
  /** A subscriber must never fail an update. */
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // Deliberately swallowed.
      }
    }
  }
  const expired = (peer: PresencePeer<Update>, at: number): boolean =>
    at - peer.updatedAt > options.ttl

  const receive = (update: PresenceUpdate<Update>): void => {
    if (update.id === options.id) return
    if (update.value === null) {
      if (peers.delete(update.id)) notify()
      return
    }
    peers.set(update.id, { id: update.id, value: update.value, updatedAt: now() })
    notify()
  }
  const unsubscribe = options.channel?.subscribe(receive)

  return {
    set: value => {
      peers.set(options.id, { id: options.id, value, updatedAt: now() })
      options.channel?.publish({ id: options.id, value })
      notify()
    },
    leave: () => {
      peers.delete(options.id)
      options.channel?.publish({ id: options.id, value: null })
      notify()
    },
    peers: () => {
      const at = now()
      return [...peers.values()].filter(peer => !expired(peer, at)).map(peer => ({ ...peer }))
    },
    prune: () => {
      const at = now()
      let changed = false
      for (const [id, peer] of peers) {
        if (expired(peer, at)) {
          peers.delete(id)
          changed = true
        }
      }
      if (changed) notify()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      unsubscribe?.()
      listeners.clear()
    },
  }
}

/** An in-process channel, for tests and single-process demos. */
export const loopbackPresenceChannel = <Update>(): PresenceChannel<Update> => {
  const listeners = new Set<(update: PresenceUpdate<Update>) => void>()
  return {
    publish: update => {
      for (const listener of [...listeners]) listener(update)
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
