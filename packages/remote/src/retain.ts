/**
 * Cache lifetime. Retention roots are the requirements (and connections) the
 * application's active Surfaces observe; `gc` keeps what they reach through
 * the store's refs plus every pending optimistic change, and drops the rest.
 * Roots live outside the Model, so GC arrives as a Message.
 */
import type { Requirement } from 'foldkit-surface'
import { refsIn } from './relation.js'
import { entityKey, readField, type EntityKey, type EntityStore } from './store.js'
import type { Connection } from './connection.js'
import type { Optimistic } from './optimistic.js'

export interface RetentionRoots {
  readonly requirements: ReadonlyArray<Requirement>
  /** Connection identities (`QueryRef.identity`) to keep, with their edges' targets. */
  readonly connections: ReadonlyArray<string>
}

export interface Retained {
  readonly entities: EntityStore
  readonly connections: Readonly<Record<string, Connection>>
}

/**
 * The entity keys the roots reach: each root entity, the targets its retained
 * fields refer to, and recursively the targets a nested relation selects.
 */
export const reachable = (
  store: EntityStore,
  roots: RetentionRoots,
  connections: Readonly<Record<string, Connection>>,
  optimistic: Optimistic,
): ReadonlySet<EntityKey> => {
  const kept = new Set<EntityKey>()
  // A target is walked once per relation spec that reaches it: two specs may
  // select different nested relations of the same entity, and a spec tree is
  // finite, so this terminates on cyclic data too.
  const walked = new Map<EntityKey, Set<Omit<Requirement, 'id'>>>()
  const visit = (key: EntityKey, requirement: Omit<Requirement, 'id'>): void => {
    kept.add(key)
    const seen = walked.get(key) ?? new Set()
    if (seen.has(requirement)) return
    seen.add(requirement)
    walked.set(key, seen)
    for (const field of requirement.fields) {
      const value = readField(store, key, field)
      if (value._tag === 'None') continue
      const relation = requirement.relations?.[field]
      for (const ref of refsIn(value.value)) {
        const target = entityKey(ref.entity, ref.id)
        if (relation === undefined || ref.entity !== relation.entity) {
          kept.add(target)
          continue
        }
        visit(target, relation)
      }
    }
  }
  for (const root of roots.requirements) visit(entityKey(root.entity, root.id), root)
  for (const identity of roots.connections) {
    for (const segment of connections[identity]?.segments ?? []) {
      for (const edge of segment.edges) kept.add(entityKey(edge.ref.entity, edge.ref.id))
    }
  }
  for (const layer of optimistic.layers) {
    for (const patch of layer.patches) kept.add(entityKey(patch.entity, patch.id))
  }
  for (const overlay of optimistic.overlays) {
    for (const edge of overlay.edges) kept.add(entityKey(edge.ref.entity, edge.ref.id))
  }
  return kept
}

/**
 * Drops every entity the roots do not reach and every connection they do not
 * name, keeping whatever a pending optimistic layer or overlay touches. Pure.
 */
export const gc = (
  state: Retained & { readonly optimistic: Optimistic },
  roots: RetentionRoots,
): Retained => {
  const kept = reachable(state.entities, roots, state.connections, state.optimistic)
  const entities = Object.fromEntries(
    Object.entries(state.entities).filter(([key]) => kept.has(key)),
  )
  const keptConnections = new Set([
    ...roots.connections,
    ...state.optimistic.overlays.map(overlay => overlay.connection),
  ])
  const connections = Object.fromEntries(
    Object.entries(state.connections).filter(([identity]) => keptConnections.has(identity)),
  )
  return { entities, connections }
}
