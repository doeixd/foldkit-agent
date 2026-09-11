/**
 * Optimistic layers. Pending changes are held as ordered layers over a base
 * store and as overlays over a connection; the visible value is recomputed, never
 * patched with inverses. Settling is remove-the-layer, so overlapping layers
 * rebase for free.
 */
import { type Connection, type Edge, items } from './connection.js'
import { reconcileMutation, type MutationState, type NormalizedPatch } from './mutation.js'
import { entityKey, writeEntity, type EntityStore } from './store.js'

export interface EntityLayer {
  readonly id: string
  readonly patches: ReadonlyArray<NormalizedPatch>
}

export interface ConnectionOverlay {
  readonly id: string
  readonly connection: string
  readonly edges: ReadonlyArray<Edge>
  readonly position: 'prepend' | 'append'
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

/** Applies a layer idempotently and removes it: a later layer re-wins on rebase. */
export const settleSuccess = (
  base: EntityStore,
  optimistic: Optimistic,
  state: MutationState,
  requestId: string,
  entities: ReadonlyArray<NormalizedPatch>,
): {
  readonly store: EntityStore
  readonly state: MutationState
  readonly optimistic: Optimistic
} => {
  const reconciled = reconcileMutation(base, state, requestId, entities)
  return {
    store: reconciled.store,
    state: reconciled.state,
    optimistic: removeLayer(optimistic, requestId),
  }
}

/** A failed layer is dropped; the base was never mutated. */
export const settleFailure = (optimistic: Optimistic, requestId: string): Optimistic =>
  removeLayer(optimistic, requestId)

/**
 * Visible edges for one connection: applicable overlays are placed outside the
 * server-known segments and de-duplicated by edge identity (across overlays too),
 * so a pending insert never corrupts server-known ordering. Boundaries still come
 * from the connection's segments.
 */
export const visibleItems = (
  connection: Connection,
  connectionId: string,
  overlays: ReadonlyArray<ConnectionOverlay>,
): ReadonlyArray<Edge> => {
  const known = items(connection)
  const seen = new Set(known.map(edge => edge.key))
  const applicable = overlays.filter(overlay => overlay.connection === connectionId)

  const take = (position: ConnectionOverlay['position']): ReadonlyArray<Edge> => {
    const edges: Edge[] = []
    for (const overlay of applicable.filter(value => value.position === position)) {
      for (const edge of overlay.edges) {
        if (seen.has(edge.key)) continue
        seen.add(edge.key)
        edges.push(edge)
      }
    }
    return edges
  }

  return [...take('prepend'), ...known, ...take('append')]
}
