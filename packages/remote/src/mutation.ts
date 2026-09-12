/**
 * Mutation status and idempotent reconciliation.
 *
 * A mutation result is reconciled into the store **at most once per
 * `requestId`**, so a transport retry cannot apply the same change twice. An
 * unknown or already-applied result is a no-op.
 */
import type { Schema } from 'effect'
import { entityKey, writeEntity, type EntityStore } from './store.js'

export interface NormalizedPatch {
  readonly entity: string
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface MutationState {
  readonly pending: ReadonlySet<string>
  readonly applied: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
}

export const emptyMutationState: MutationState = {
  pending: new Set(),
  applied: new Set(),
  failed: new Set(),
}

/**
 * How many settled request ids a mutation state retains. A retry settles well
 * inside this window, so bounding the ledger stops a long-lived application
 * from growing it without limit; a retry older than the window would re-apply
 * its entities.
 */
const MUTATION_ID_WINDOW = 1024

/** Records `id` as most recent, evicting the oldest once the window is full. */
const remember = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids)
  // Re-inserting an existing id moves it to the most-recent end.
  next.delete(id)
  next.add(id)
  if (next.size <= MUTATION_ID_WINDOW) return next
  return new Set([...next].slice(next.size - MUTATION_ID_WINDOW))
}

export const beginMutation = (state: MutationState, requestId: string): MutationState => ({
  ...state,
  pending: new Set([...state.pending, requestId]),
})

export const failMutation = (state: MutationState, requestId: string): MutationState => {
  const pending = new Set(state.pending)
  pending.delete(requestId)
  return { ...state, pending, failed: remember(state.failed, requestId) }
}

export interface Reconciled {
  readonly store: EntityStore
  readonly state: MutationState
}

/**
 * Applies a mutation result once and marks the request settled. A second call
 * with the same `requestId` (a retry, or a live event describing the same change)
 * does not re-apply the entities, but still clears `pending`.
 */
export const reconcileMutation = (
  store: EntityStore,
  state: MutationState,
  requestId: string,
  entities: ReadonlyArray<NormalizedPatch>,
): Reconciled => {
  const next = state.applied.has(requestId)
    ? store
    : entities.reduce(
        (current, entity) =>
          writeEntity(current, entityKey(entity.entity, entity.id), entity.values),
        store,
      )
  const applied = remember(state.applied, requestId)
  const pending = new Set(state.pending)
  pending.delete(requestId)
  return { store: next, state: { ...state, applied, pending } }
}

/** A mutation an application declares: its name and input/output codecs. */
export interface MutationDescriptor<Name extends string, Input, Output> {
  readonly name: Name
  readonly Input: Schema.Codec<Input>
  readonly Output: Schema.Codec<Output>
}

export const Mutation = {
  make: <const Name extends string, Input, Output>(
    name: Name,
    config: { readonly Input: Schema.Codec<Input>; readonly Output: Schema.Codec<Output> },
  ): MutationDescriptor<Name, Input, Output> => ({
    name,
    Input: config.Input,
    Output: config.Output,
  }),
}
