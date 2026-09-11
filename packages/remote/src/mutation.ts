/**
 * Mutation status and idempotent reconciliation.
 *
 * A mutation result is reconciled into the store **at most once per
 * `requestId`**, so a transport retry cannot apply the same change twice. An
 * unknown or already-applied result is a no-op.
 */
import { Effect, Schema } from 'effect'
import { RemoteClient, type MutationDescriptor } from './index.js'
import { RemoteMutationError } from './wire.js'
import { entityKey, writeEntity, type EntityStore } from './store.js'

export interface NormalizedPatch {
  readonly entity: string
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Runs a mutation through `RemoteClient`, decoding its typed Output. The
 * `requestId` is stable across transport retries so the server can dedupe and
 * `reconcileMutation` can apply the result at most once.
 */
export const mutate = <Name extends string, Input, Output>(
  mutation: MutationDescriptor<Name, Input, Output>,
  input: Input,
  requestId: string,
): Effect.Effect<Output, RemoteMutationError, RemoteClient> =>
  Effect.gen(function* () {
    const client = yield* RemoteClient
    const result = yield* client.mutate({
      requestId,
      mutation: mutation.name,
      input: Schema.encodeSync(mutation.Input)(input),
    })
    return Schema.decodeUnknownSync(mutation.Output)(result.output)
  })

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

export const beginMutation = (state: MutationState, requestId: string): MutationState => ({
  ...state,
  pending: new Set([...state.pending, requestId]),
})

export const failMutation = (state: MutationState, requestId: string): MutationState => {
  const pending = new Set(state.pending)
  pending.delete(requestId)
  return { ...state, pending, failed: new Set([...state.failed, requestId]) }
}

export interface Reconciled {
  readonly store: EntityStore
  readonly state: MutationState
}

/**
 * Applies a mutation result once. A second call with the same `requestId` (a
 * retry, or a live event describing the same change) is a no-op.
 */
export const reconcileMutation = (
  store: EntityStore,
  state: MutationState,
  requestId: string,
  entities: ReadonlyArray<NormalizedPatch>,
): Reconciled => {
  if (state.applied.has(requestId)) return { store, state }
  const next = entities.reduce(
    (current, entity) => writeEntity(current, entityKey(entity.entity, entity.id), entity.values),
    store,
  )
  const applied = new Set(state.applied)
  applied.add(requestId)
  const pending = new Set(state.pending)
  pending.delete(requestId)
  return { store: next, state: { ...state, applied, pending } }
}
