import { Clock, Duration, Effect, Fiber, PubSub, Ref, Stream, type Scope } from 'effect'
import type { SocketLike } from './transport.js'

/** One peer's presence. A `null` value means the peer left. */
export interface PresenceUpdate<Update> {
  readonly id: string
  readonly value: Update | null
}

/**
 * The ephemeral channel presence travels on.
 *
 * `updates` is the inbound bus a peer consumes; `publish` sends one to the bus.
 * Splitting them keeps an inbound update from being echoed straight back out.
 * This is deliberately not the durable transport: presence is broadcast, never
 * journaled, so a dropped or duplicated update is harmless.
 */
export interface PresenceChannel<Update> {
  readonly updates: PubSub.PubSub<PresenceUpdate<Update>>
  readonly publish: (update: PresenceUpdate<Update>) => Effect.Effect<void>
}

export interface PresenceOptions<Update> {
  /** This peer's identity on the channel. */
  readonly id: string
  /** How long a peer may go without refreshing before it is dropped. */
  readonly ttl: Duration.Input
  /**
   * Validates the untrusted value a peer sends before it is stored. Presence
   * crosses a wire, so this is required rather than trusting the type
   * parameter; a value it rejects is dropped.
   */
  readonly decodeValue: (value: unknown) => Update
  readonly channel?: PresenceChannel<Update> | undefined
}

export interface PresencePeer<Update> {
  readonly id: string
  readonly value: Update
  readonly updatedAt: number
}

export interface Presence<Update> {
  /** Sets this peer's value and broadcasts it. */
  readonly set: (value: Update) => Effect.Effect<void>
  /** Removes this peer and broadcasts the departure. */
  readonly leave: Effect.Effect<void>
  /** Live peers, self included, with stale ones excluded. */
  readonly peers: Effect.Effect<ReadonlyArray<PresencePeer<Update>>>
  /** Drops expired peers; notifies if any went. */
  readonly prune: Effect.Effect<void>
  /** Notified when the peer set changes. */
  readonly subscribe: (listener: () => void) => () => void
  /**
   * The live peers, re-emitted whenever the set changes. The `Stream` form of
   * `subscribe`, for a consumer that composes with Effect.
   */
  readonly changes: Stream.Stream<ReadonlyArray<PresencePeer<Update>>>
  /** Stops consuming the channel; the enclosing scope also does this on exit. */
  readonly close: Effect.Effect<void>
}

/**
 * Tracks ephemeral peers with a time-to-live.
 *
 * Nothing here touches the durable log: presence is state a peer refreshes, and
 * a peer that stops refreshing is dropped, not replayed. Time comes from the
 * `Clock`, so a `TestClock` drives the TTL deterministically.
 */
export const createPresence = Effect.fn('Presence.create')(function* <Update>(
  options: PresenceOptions<Update>,
) {
  const ttl = Duration.toMillis(options.ttl)
  const peers = yield* Ref.make(new Map<string, PresencePeer<Update>>())
  const closed = yield* Ref.make(false)
  const signals = yield* PubSub.sliding<void>(1)
  const listeners = new Set<() => void>()
  /** A subscriber must never fail an update. */
  const notify = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // Deliberately swallowed.
        }
      }
      yield* PubSub.publish(signals, undefined)
    })
  const expired = (peer: PresencePeer<Update>, at: number): boolean => at - peer.updatedAt > ttl

  const put = (id: string, value: Update, at: number): Effect.Effect<void> =>
    Ref.update(peers, map => {
      const next = new Map(map)
      next.set(id, { id, value, updatedAt: at })
      return next
    })
  const remove = (id: string): Effect.Effect<boolean> =>
    Ref.modify(peers, map => {
      if (!map.has(id)) return [false, map] as const
      const next = new Map(map)
      next.delete(id)
      return [true, next] as const
    })

  const receive = Effect.fn('Presence.receive')(function* (update: PresenceUpdate<Update>) {
    if (update.id === options.id) return
    if (update.value === null) {
      if (yield* remove(update.id)) yield* notify()
      return
    }
    let value: Update
    try {
      value = options.decodeValue(update.value)
    } catch {
      // A peer's value that fails the contract is dropped, never stored.
      return
    }
    yield* put(update.id, value, yield* Clock.currentTimeMillis)
    yield* notify()
  })

  const channel = options.channel
  const consuming =
    channel === undefined
      ? undefined
      : yield* Stream.runForEach(Stream.fromPubSub(channel.updates), receive).pipe(
          Effect.forkScoped,
        )

  const set = Effect.fn('Presence.set')(function* (value: Update) {
    if (yield* Ref.get(closed)) return
    yield* put(options.id, value, yield* Clock.currentTimeMillis)
    if (channel !== undefined) yield* channel.publish({ id: options.id, value })
    yield* notify()
  })

  const leave = Effect.fn('Presence.leave')(function* () {
    if (yield* Ref.get(closed)) return
    yield* remove(options.id)
    if (channel !== undefined) yield* channel.publish({ id: options.id, value: null })
    yield* notify()
  })()

  const peerList = Effect.fn('Presence.peers')(function* () {
    const at = yield* Clock.currentTimeMillis
    const map = yield* Ref.get(peers)
    return [...map.values()].filter(peer => !expired(peer, at)).map(peer => ({ ...peer }))
  })()

  const prune = Effect.fn('Presence.prune')(function* () {
    if (yield* Ref.get(closed)) return
    const at = yield* Clock.currentTimeMillis
    const changed = yield* Ref.modify(peers, map => {
      let removed = false
      const next = new Map(map)
      for (const [id, peer] of map) {
        if (expired(peer, at)) {
          next.delete(id)
          removed = true
        }
      }
      return [removed, next] as const
    })
    if (changed) yield* notify()
  })()

  const close = Effect.fn('Presence.close')(function* () {
    if (yield* Ref.get(closed)) return
    yield* Ref.set(closed, true)
    if (consuming !== undefined) yield* Fiber.interrupt(consuming)
    yield* Effect.sync(() => listeners.clear())
    yield* PubSub.shutdown(signals)
  })()

  return {
    set,
    leave,
    peers: peerList,
    prune,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changes: Stream.concat(
      Stream.fromEffect(peerList),
      Stream.fromPubSub(signals).pipe(Stream.mapEffect(() => peerList)),
    ),
    close,
  }
})

/** An in-process channel, for tests and single-process demos. */
export const loopbackPresenceChannel = Effect.fn('Presence.loopbackChannel')(function* <Update>() {
  const updates = yield* PubSub.unbounded<PresenceUpdate<Update>>()
  return {
    updates,
    publish: (update: PresenceUpdate<Update>) => PubSub.publish(updates, update),
  }
})

/** Broadcasts presence updates among connected peers. */
export interface PresenceHub<Update> {
  /** Registers a peer's send; returns a leave function. */
  join(send: (update: PresenceUpdate<Update>) => void): () => void
  /** Fans an update out to every joined peer. */
  publish(update: PresenceUpdate<Update>): void
}

export const createPresenceHub = <Update>(): PresenceHub<Update> => {
  const peers = new Set<(update: PresenceUpdate<Update>) => void>()
  return {
    join: send => {
      peers.add(send)
      return () => peers.delete(send)
    },
    publish: update => {
      for (const send of [...peers]) {
        try {
          send(update)
        } catch {
          // One broken peer must not starve the rest of the fan-out.
        }
      }
    },
  }
}

const frameType = 'presence'

/** A presence frame. `id` is set by the server that owns the identity. */
interface PresenceFrame<Update> {
  readonly id: string | undefined
  readonly value: Update | null
}

/** Decodes a presence frame, ignoring anything else a socket may carry. */
const decodePresence = <Update>(data: string): PresenceFrame<Update> | undefined => {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
  const payload = frame[frameType]
  if (typeof payload !== 'object' || payload === null) return undefined
  const { id, value } = payload as { id?: unknown; value?: unknown }
  return { id: typeof id === 'string' ? id : undefined, value: (value ?? null) as Update | null }
}

/**
 * A presence channel fed by stamped frames from the server, sent back without an
 * id: the server owns peer identity, so a client cannot assert another's.
 */
export const socketPresenceChannel = <Update>(
  socket: SocketLike,
): Effect.Effect<PresenceChannel<Update>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded<PresenceUpdate<Update>>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        socket.onMessage(data => {
          const frame = decodePresence<Update>(data)
          // An unstamped frame is not from the server and carries no identity.
          if (frame === undefined || frame.id === undefined) return
          PubSub.publishUnsafe(updates, { id: frame.id, value: frame.value })
        }),
      ),
      off => Effect.sync(off),
    )
    return {
      updates,
      publish: update =>
        Effect.sync(() => socket.send(JSON.stringify({ [frameType]: { value: update.value } }))),
    }
  })

/** Serves presence frames on an accepted socket, stamping the connection's identity. */
export const servePresence = <Update>(
  socket: SocketLike,
  hub: PresenceHub<Update>,
  options: { readonly peerId: string },
): (() => void) => {
  const send = (update: PresenceUpdate<Update>): void =>
    socket.send(JSON.stringify({ [frameType]: { id: update.id, value: update.value } }))
  const leave = hub.join(send)
  const off = socket.onMessage(data => {
    const frame = decodePresence<Update>(data)
    // The connection owns the identity; a client-supplied id is ignored.
    if (frame !== undefined) hub.publish({ id: options.peerId, value: frame.value })
  })
  return () => {
    off()
    leave()
  }
}
