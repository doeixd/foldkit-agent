/**
 * Live data. Entity facts update the store; connection facts change ordering and
 * membership. Events carry a monotonic cursor ordered **per stream**: duplicates
 * are ignored, and a gap is surfaced so the caller can resume or invalidate.
 * Subscriptions are selection-aware and driven by active Surfaces.
 */
import type { EdgeRef } from './connection.js'
import { type Connection, type Edge, hasNext, hasPrevious } from './connection.js'
import { addOverlay, type OptimisticState } from './optimistic.js'
import type { LiveInsertion, LivePolicy } from './query.js'
import { entityKey, tombstone, writeEntity, type EntityStore } from './store.js'

export type LiveCursor = number

export type LiveEvent =
  | {
      readonly _tag: 'EntityPatched'
      readonly ref: EdgeRef
      readonly values: Readonly<Record<string, unknown>>
      readonly changed: ReadonlyArray<string>
      readonly cursor: LiveCursor
    }
  | { readonly _tag: 'EntityDeleted'; readonly ref: EdgeRef; readonly cursor: LiveCursor }
  | {
      readonly _tag: 'ConnectionInsert'
      readonly connection: string
      readonly position: 'prepend' | 'append'
      readonly edge: Edge
      readonly cursor: LiveCursor
    }
  | {
      readonly _tag: 'ConnectionRemove'
      readonly connection: string
      readonly edge: Edge
      readonly cursor: LiveCursor
    }
  | {
      readonly _tag: 'ConnectionInvalidate'
      readonly connection: string
      readonly cursor: LiveCursor
    }

export interface BoundaryCounts {
  readonly before: number
  readonly after: number
}

export interface LiveState {
  /** Last applied cursor for this stream. */
  readonly cursor: LiveCursor
  /** Connections marked stale by an invalidating event. */
  readonly stale: ReadonlySet<string>
  /** Edges recorded outside the loaded boundary, not visible in `items`. */
  readonly boundary: Readonly<Record<string, BoundaryCounts>>
}

export const emptyLiveState: LiveState = { cursor: 0, stale: new Set(), boundary: {} }

export type LiveOutcome = 'applied' | 'duplicate' | 'gap'

/**
 * Ordering per stream: at most the next cursor; ahead is a gap. Cursor `0` means
 * "no baseline yet" (cursors are 1-based), so the first event of a stream is
 * accepted whatever its cursor — otherwise a stream not starting at 1 would be a
 * spurious gap.
 */
export const classifyLive = (state: LiveState, cursor: LiveCursor): LiveOutcome =>
  cursor <= state.cursor
    ? 'duplicate'
    : state.cursor === 0 || cursor === state.cursor + 1
      ? 'applied'
      : 'gap'

const advance = (state: LiveState, cursor: LiveCursor): LiveState => ({ ...state, cursor })

const recordBoundary = (
  state: LiveState,
  connection: string,
  position: 'prepend' | 'append',
): LiveState => {
  const current = state.boundary[connection] ?? { before: 0, after: 0 }
  const next =
    position === 'prepend'
      ? { ...current, before: current.before + 1 }
      : { ...current, after: current.after + 1 }
  return { ...state, boundary: { ...state.boundary, [connection]: next } }
}

export const invalidateConnection = (state: LiveState, connection: string): LiveState => ({
  ...state,
  stale: new Set([...state.stale, connection]),
})

/**
 * A subscriber is woken only if the event changed a field it selects. A
 * change to an unselected field is skipped entirely.
 */
export const shouldWake = (
  changed: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
): boolean => changed.some(field => selected.includes(field))

export interface EntityApplied {
  readonly state: LiveState
  readonly store: EntityStore
  readonly outcome: LiveOutcome
}

export const applyEntityEvent = (
  state: LiveState,
  store: EntityStore,
  event: Extract<LiveEvent, { _tag: 'EntityPatched' | 'EntityDeleted' }>,
  now = 0,
): EntityApplied => {
  const outcome = classifyLive(state, event.cursor)
  if (outcome !== 'applied') return { state, store, outcome }
  const key = entityKey(event.ref.entity, event.ref.id)
  const next =
    event._tag === 'EntityPatched'
      ? writeEntity(store, key, event.values, now)
      : tombstone(store, key)
  return { state: advance(state, event.cursor), store: next, outcome }
}

export interface ConnectionApplied {
  readonly state: LiveState
  readonly optimistic: OptimisticState
  readonly outcome: LiveOutcome
}

const removeEdgeOverlays = (
  optimistic: OptimisticState,
  connection: string,
  key: string,
): OptimisticState => ({
  ...optimistic,
  overlays: optimistic.overlays.map(overlay =>
    overlay.connection !== connection || overlay.position === 'remove'
      ? overlay
      : { ...overlay, edges: overlay.edges.filter(edge => edge.key !== key) },
  ),
})

export const applyConnectionEvent = (
  state: LiveState,
  optimistic: OptimisticState,
  event: Extract<
    LiveEvent,
    { _tag: 'ConnectionInsert' | 'ConnectionRemove' | 'ConnectionInvalidate' }
  >,
  policy: LivePolicy = {},
): ConnectionApplied => {
  const outcome = classifyLive(state, event.cursor)
  if (outcome !== 'applied') return { state, optimistic, outcome }

  switch (event._tag) {
    case 'ConnectionInsert': {
      const selection: LiveInsertion =
        (event.position === 'prepend' ? policy.prepend : policy.append) ?? 'visible'
      switch (selection) {
        case 'visible':
          return {
            state: advance(state, event.cursor),
            optimistic: addOverlay(optimistic, {
              id: `live:${event.cursor}`,
              connection: event.connection,
              edges: [event.edge],
              position: event.position,
            }),
            outcome,
          }
        case 'boundary':
          return {
            state: recordBoundary(advance(state, event.cursor), event.connection, event.position),
            optimistic,
            outcome,
          }
        case 'invalidate':
          return {
            state: invalidateConnection(advance(state, event.cursor), event.connection),
            optimistic,
            outcome,
          }
        case 'ignore':
          return { state: advance(state, event.cursor), optimistic, outcome }
      }
    }
    case 'ConnectionRemove':
      // Strip the edge from pending inserts and hide it wherever else it is
      // (a server-known segment included) until a fresh page says otherwise.
      return {
        state: advance(state, event.cursor),
        optimistic: addOverlay(removeEdgeOverlays(optimistic, event.connection, event.edge.key), {
          id: `live:${event.cursor}`,
          connection: event.connection,
          edges: [event.edge],
          position: 'remove',
        }),
        outcome,
      }
    case 'ConnectionInvalidate':
      return {
        state: invalidateConnection(advance(state, event.cursor), event.connection),
        optimistic,
        outcome,
      }
  }
}

export const isStale = (state: LiveState, connection: string): boolean =>
  state.stale.has(connection)

/**
 * Clears a connection's stale mark once a fresh page has been adopted. An
 * invalidating event only records that a refetch is due; whoever merges the
 * refetched page calls this so `isStale` stops reporting.
 */
export const refreshConnection = (state: LiveState, connection: string): LiveState => {
  if (!state.stale.has(connection)) return state
  const stale = new Set(state.stale)
  stale.delete(connection)
  return { ...state, stale }
}

/** `hasPrevious` accounting for edges recorded outside the loaded boundary. */
export const liveHasPrevious = (
  connection: Connection,
  state: LiveState,
  connectionId: string,
): boolean => hasPrevious(connection) || (state.boundary[connectionId]?.before ?? 0) > 0

/** `hasNext` accounting for edges recorded outside the loaded boundary. */
export const liveHasNext = (
  connection: Connection,
  state: LiveState,
  connectionId: string,
): boolean => hasNext(connection) || (state.boundary[connectionId]?.after ?? 0) > 0
