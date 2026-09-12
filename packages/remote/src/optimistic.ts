/**
 * Optimistic layers. Pending changes are held as ordered layers over a base
 * store and as overlays over a connection; the visible value is recomputed, never
 * patched with inverses. Settling is remove-the-layer, so overlapping layers
 * rebase for free.
 */
import { type Connection, type Edge, edge, items } from './connection.js'
import { reconcileMutation, type MutationState, type NormalizedPatch } from './mutation.js'
import { entityKey, writeEntity, type EntityStore } from './store.js'

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

/** Constructors for the connection half of a request's optimistic operations. */
export const Optimistic = {
  prepend: (
    connection: string | { readonly identity: string },
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => ({
    _tag: 'Insert',
    connection: typeof connection === 'string' ? connection : connection.identity,
    position: 'prepend',
    edge: edge({ entity: ref.entity, id: ref.id }),
  }),

  append: (
    connection: string | { readonly identity: string },
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => ({
    _tag: 'Insert',
    connection: typeof connection === 'string' ? connection : connection.identity,
    position: 'append',
    edge: edge({ entity: ref.entity, id: ref.id }),
  }),

  remove: (
    connection: string | { readonly identity: string },
    ref: { readonly entity: string; readonly id: string },
  ): ConnectionChange => ({
    _tag: 'Remove',
    connection: typeof connection === 'string' ? connection : connection.identity,
    edge: edge({ entity: ref.entity, id: ref.id }),
  }),

  /**
   * Applies a request's operations: its patches become one layer and its
   * connection changes become overlays, all owned by `requestId` so settling
   * removes every one of them together.
   */
  begin: (
    optimistic: Optimistic,
    requestId: string,
    operations: ReadonlyArray<OptimisticOperation>,
  ): Optimistic => {
    const patches = operations.filter(
      (operation): operation is NormalizedPatch => !isConnectionChange(operation),
    )
    const changes = operations.filter(isConnectionChange)
    return {
      layers:
        patches.length === 0
          ? optimistic.layers
          : [...optimistic.layers, { id: requestId, patches }],
      overlays: [...optimistic.overlays, ...toOverlays(requestId, changes)],
    }
  },

  /**
   * Replaces a request's overlays with the server-confirmed changes, owned by
   * `id`, in the position the request's overlays held, so a confirmed edge
   * keeps its place among other pending inserts.
   */
  confirm: (
    optimistic: Optimistic,
    requestId: string,
    id: string,
    changes: ReadonlyArray<ConnectionChange>,
  ): Optimistic => {
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
  },
}

export interface Optimistic {
  readonly layers: ReadonlyArray<EntityLayer>
  readonly overlays: ReadonlyArray<ConnectionOverlay>
}

export const emptyOptimistic: Optimistic = { layers: [], overlays: [] }

export const addLayer = (optimistic: Optimistic, layer: EntityLayer): Optimistic => ({
  ...optimistic,
  layers: [...optimistic.layers, layer],
})

export const removeLayer = (optimistic: Optimistic, id: string): Optimistic => ({
  ...optimistic,
  layers: optimistic.layers.filter(layer => layer.id !== id),
})

export const addOverlay = (optimistic: Optimistic, overlay: ConnectionOverlay): Optimistic => ({
  ...optimistic,
  overlays: [...optimistic.overlays, overlay],
})

export const removeOverlay = (optimistic: Optimistic, id: string): Optimistic => ({
  ...optimistic,
  overlays: optimistic.overlays.filter(overlay => overlay.id !== id),
})

/** Base store with every layer applied in order. Later layers win. */
export const visibleStore = (base: EntityStore, optimistic: Optimistic): EntityStore =>
  optimistic.layers.reduce(
    (store, layer) =>
      layer.patches.reduce(
        (current, patch) => writeEntity(current, entityKey(patch.entity, patch.id), patch.values),
        store,
      ),
    base,
  )

/** Everything a request owns: its layer and its overlays. */
const release = (optimistic: Optimistic, requestId: string): Optimistic =>
  removeOverlay(removeLayer(optimistic, requestId), requestId)

/**
 * Applies a result idempotently and releases the request's layer and overlays:
 * a later layer re-wins on rebase. Confirmed connection changes are recorded
 * once per request, as overlays the request no longer owns.
 */
export const settleSuccess = (
  base: EntityStore,
  optimistic: Optimistic,
  state: MutationState,
  requestId: string,
  entities: ReadonlyArray<NormalizedPatch>,
  connections: ReadonlyArray<ConnectionChange> = [],
): {
  readonly store: EntityStore
  readonly state: MutationState
  readonly optimistic: Optimistic
} => {
  const reconciled = reconcileMutation(base, state, requestId, entities)
  return {
    store: reconciled.store,
    state: reconciled.state,
    optimistic: state.applied.has(requestId)
      ? release(optimistic, requestId)
      : Optimistic.confirm(
          removeLayer(optimistic, requestId),
          requestId,
          `confirmed:${requestId}`,
          connections,
        ),
  }
}

/** A failed request's layer and overlays are dropped; the base was never mutated. */
export const settleFailure = (optimistic: Optimistic, requestId: string): Optimistic =>
  release(optimistic, requestId)

/**
 * Visible edges for one connection: applicable overlays are placed outside the
 * server-known segments and de-duplicated by edge identity (across overlays too),
 * so a pending insert never corrupts server-known ordering; a `remove` overlay
 * hides its edges wherever they are. A later prepend lands before an earlier
 * one, a later append after, so pending inserts read in the order they were
 * made. Boundaries still come from the connection's segments.
 */
export const visibleItems = (
  connection: Connection,
  connectionId: string,
  overlays: ReadonlyArray<ConnectionOverlay>,
): ReadonlyArray<Edge> => {
  const applicable = overlays.filter(overlay => overlay.connection === connectionId)
  const hidden = new Set(
    applicable
      .filter(overlay => overlay.position === 'remove')
      .flatMap(overlay => overlay.edges.map(edge => edge.key)),
  )
  const known = items(connection).filter(edge => !hidden.has(edge.key))
  const seen = new Set(known.map(edge => edge.key))

  const take = (position: 'prepend' | 'append'): ReadonlyArray<Edge> => {
    const edges: Edge[] = []
    const ordered = applicable.filter(value => value.position === position)
    for (const overlay of position === 'prepend' ? [...ordered].reverse() : ordered) {
      for (const edge of overlay.edges) {
        if (seen.has(edge.key) || hidden.has(edge.key)) continue
        seen.add(edge.key)
        edges.push(edge)
      }
    }
    return edges
  }

  return [...take('prepend'), ...known, ...take('append')]
}
