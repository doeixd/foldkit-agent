/**
 * Optimistic layers. Pending changes are held as ordered layers over a base
 * store and as overlays over a connection; the visible value is recomputed, never
 * patched with inverses. Settling is remove-the-layer, so overlapping layers
 * rebase for free.
 */
import { type Connection, type Edge, edge, items } from './connection.js'
import { reconcileMutation, type MutationState, type NormalizedPatch } from './mutation.js'
import { entityKey, isTombstone, writeEntity, type EntityStore } from './store.js'

export interface EntityLayer {
  readonly id: string
  readonly patches: ReadonlyArray<NormalizedPatch>
}

/**
 * Edges placed outside a connection's server-known region (`prepend`,
 * `append`) or hidden from it (`remove`), owned by the request or live event
 * that produced them.
 */
export interface ConnectionOverlay {
  readonly id: string
  readonly connection: string
  readonly edges: ReadonlyArray<Edge>
  readonly position: 'prepend' | 'append' | 'remove'
}

/** A connection change a request makes optimistically or a mutation result confirms. */
export type ConnectionChange =
  | {
      readonly _tag: 'Insert'
      readonly connection: string
      readonly position: 'prepend' | 'append'
      readonly edge: Edge
    }
  | { readonly _tag: 'Remove'; readonly connection: string; readonly edge: Edge }

/** What a request changes before the server answers: entity patches and connection changes. */
export type OptimisticOperation = NormalizedPatch | ConnectionChange

const isConnectionChange = (operation: OptimisticOperation): operation is ConnectionChange =>
  '_tag' in operation

const toOverlays = (id: string, changes: ReadonlyArray<ConnectionChange>): ConnectionOverlay[] =>
  changes.map(change => ({
    id,
    connection: change.connection,
    edges: [change.edge],
    position: change._tag === 'Insert' ? change.position : 'remove',
  }))

/** A connection, by identity string or by anything that carries one (a `QueryRef`). */
export type ConnectionIdentity = string | { readonly identity: string }

export const connectionIdentity = (connection: ConnectionIdentity): string =>
  typeof connection === 'string' ? connection : connection.identity

const change = (
  connection: ConnectionIdentity,
  ref: { readonly entity: string; readonly id: string },
  position: 'prepend' | 'append' | 'remove',
): ConnectionChange =>
  position === 'remove'
    ? { _tag: 'Remove', connection: connectionIdentity(connection), edge: edge(ref) }
    : { _tag: 'Insert', connection: connectionIdentity(connection), position, edge: edge(ref) }

/**
 * Constructors for connection changes: what a request shows optimistically
 * (`MutateOptions.optimistic`) and what a mutation source reports it made
 * (`MutationOutcome.connections`).
 */
export const ConnectionChange = {
  /** Show `ref` at the front of the connection until the request settles. */
  prepend: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => change(connection, ref, 'prepend'),

  /** Show `ref` at the end of the connection until the request settles. */
  append: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => change(connection, ref, 'append'),

  /** Hide `ref` from the connection until the request settles. */
  remove: (
    connection: ConnectionIdentity,
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => change(connection, ref, 'remove'),
}

/**
 * Applies a request's operations: its patches become one layer and its
 * connection changes become overlays, all owned by `requestId` so settling
 * removes every one of them together.
 */
export const beginOptimistic = (
  optimistic: OptimisticState,
  requestId: string,
  operations: ReadonlyArray<OptimisticOperation>,
): OptimisticState => {
  const patches = operations.filter(
    (operation): operation is NormalizedPatch => !isConnectionChange(operation),
  )
  const changes = operations.filter(isConnectionChange)
  return {
    layers:
      patches.length === 0 ? optimistic.layers : [...optimistic.layers, { id: requestId, patches }],
    overlays: [...optimistic.overlays, ...toOverlays(requestId, changes)],
  }
}

/**
 * Replaces a request's overlays with the server-confirmed changes, owned by
 * `id`, in the position the request's overlays held, so a confirmed edge keeps
 * its place among other pending inserts.
 */
const confirm = (
  optimistic: OptimisticState,
  requestId: string,
  id: string,
  changes: ReadonlyArray<ConnectionChange>,
): OptimisticState => {
  const confirmed = toOverlays(id, changes)
  const at = optimistic.overlays.findIndex(overlay => overlay.id === requestId)
  const others = optimistic.overlays.filter(overlay => overlay.id !== requestId)
  return {
    ...optimistic,
    overlays:
      at === -1
        ? [...others, ...confirmed]
        : [...others.slice(0, at), ...confirmed, ...others.slice(at)],
  }
}

/** Pending entity layers and connection overlays over the base store. */
export interface OptimisticState {
  readonly layers: ReadonlyArray<EntityLayer>
  readonly overlays: ReadonlyArray<ConnectionOverlay>
}

export const emptyOptimistic: OptimisticState = { layers: [], overlays: [] }

export const addLayer = (optimistic: OptimisticState, layer: EntityLayer): OptimisticState => ({
  ...optimistic,
  layers: [...optimistic.layers, layer],
})

export const removeLayer = (optimistic: OptimisticState, id: string): OptimisticState => ({
  ...optimistic,
  layers: optimistic.layers.filter(layer => layer.id !== id),
})

export const addOverlay = (
  optimistic: OptimisticState,
  overlay: ConnectionOverlay,
): OptimisticState => ({
  ...optimistic,
  overlays: [...optimistic.overlays, overlay],
})

export const removeOverlay = (optimistic: OptimisticState, id: string): OptimisticState => ({
  ...optimistic,
  overlays: optimistic.overlays.filter(overlay => overlay.id !== id),
})

/** Base store with every layer applied in order. Later layers win. */
export const visibleStore = (base: EntityStore, optimistic: OptimisticState): EntityStore =>
  optimistic.layers.reduce(
    (store, layer) =>
      layer.patches.reduce(
        (current, patch) => writeEntity(current, entityKey(patch.entity, patch.id), patch.values),
        store,
      ),
    base,
  )

/**
 * A fresh page is newer than any settled overlay it covers: an edge the page
 * carries no longer needs an insert overlay, and a `remove` overlay hiding it
 * is stale (the server says it is back). A pending request's overlays are
 * left alone; they settle with the request.
 */
export const pruneOverlays = (
  optimistic: OptimisticState,
  connection: string,
  covered: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): OptimisticState => ({
  ...optimistic,
  overlays: optimistic.overlays.flatMap(overlay => {
    if (overlay.connection !== connection || pending.has(overlay.id)) return [overlay]
    const edges = overlay.edges.filter(edge => !covered.has(edge.key))
    return edges.length === 0 ? [] : [{ ...overlay, edges }]
  }),
})

/** Everything a request owns: its layer and its overlays. */
const release = (optimistic: OptimisticState, requestId: string): OptimisticState =>
  removeOverlay(removeLayer(optimistic, requestId), requestId)

/**
 * Applies a result idempotently and releases the request's layer and overlays:
 * a later layer re-wins on rebase. Confirmed connection changes are recorded
 * once per request, as overlays the request no longer owns.
 */
export const settleSuccess = (
  base: EntityStore,
  optimistic: OptimisticState,
  state: MutationState,
  requestId: string,
  entities: ReadonlyArray<NormalizedPatch>,
  connections: ReadonlyArray<ConnectionChange> = [],
): {
  readonly store: EntityStore
  readonly state: MutationState
  readonly optimistic: OptimisticState
} => {
  const reconciled = reconcileMutation(base, state, requestId, entities)
  return {
    store: reconciled.store,
    state: reconciled.state,
    optimistic: state.applied.has(requestId)
      ? release(optimistic, requestId)
      : confirm(
          removeLayer(optimistic, requestId),
          requestId,
          `confirmed:${requestId}`,
          connections,
        ),
  }
}

/** A failed request's layer and overlays are dropped; the base was never mutated. */
export const settleFailure = (optimistic: OptimisticState, requestId: string): OptimisticState =>
  release(optimistic, requestId)

/**
 * Visible edges for one connection: applicable overlays are placed outside the
 * server-known segments and de-duplicated by edge identity (across overlays too),
 * so a pending insert never corrupts server-known ordering; a `remove` overlay
 * hides its edges wherever they are, and so does a tombstone on the edge's
 * target when `store` is given. A later prepend lands before an earlier one, a
 * later append after, so pending inserts read in the order they were made.
 * Boundaries still come from the connection's segments.
 */
export const visibleItems = (
  connection: Connection,
  connectionId: string,
  overlays: ReadonlyArray<ConnectionOverlay>,
  store?: EntityStore,
): ReadonlyArray<Edge> => {
  const applicable = overlays.filter(overlay => overlay.connection === connectionId)
  // Overlays are ordered evidence: the last word on an edge wins, so a remove
  // hides it only until a later insert brings it back.
  const hidden = new Set<string>()
  for (const overlay of applicable) {
    for (const edge of overlay.edges) {
      if (overlay.position === 'remove') hidden.add(edge.key)
      else hidden.delete(edge.key)
    }
  }
  const gone = (edge: Edge): boolean =>
    hidden.has(edge.key) ||
    (store !== undefined && isTombstone(store, entityKey(edge.ref.entity, edge.ref.id)))
  const known = items(connection).filter(edge => !gone(edge))
  const seen = new Set(known.map(edge => edge.key))

  const take = (position: 'prepend' | 'append'): ReadonlyArray<Edge> => {
    const edges: Edge[] = []
    const ordered = applicable.filter(value => value.position === position)
    for (const overlay of position === 'prepend' ? [...ordered].reverse() : ordered) {
      for (const edge of overlay.edges) {
        if (seen.has(edge.key) || gone(edge)) continue
        seen.add(edge.key)
        edges.push(edge)
      }
    }
    return edges
  }

  return [...take('prepend'), ...known, ...take('append')]
}
