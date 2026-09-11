/**
 * The Remote wire: Effect RPC semantics over `effect/unstable/rpc`. Remote owns
 * the message shapes; Effect owns the transport. `Make`ing reads batch, mutations
 * preserve order, and live data is a stream.
 */
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'

export class RemoteReadError extends Schema.TaggedError<RemoteReadError>()('RemoteReadError', {
  message: Schema.String,
}) {}

export class RemoteMutationError extends Schema.TaggedError<RemoteMutationError>()(
  'RemoteMutationError',
  { message: Schema.String },
) {}

export class RemoteLiveError extends Schema.TaggedError<RemoteLiveError>()('RemoteLiveError', {
  message: Schema.String,
}) {}

export const ReadRequest = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  fields: Schema.Array(Schema.String),
})

export const ReadBatch = Schema.Struct({ requests: Schema.Array(ReadRequest) })

export const NormalizedEntity = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.Unknown),
})

export const ReadBatchResult = Schema.Struct({ entities: Schema.Array(NormalizedEntity) })

export const MutationRequest = Schema.Struct({
  /** Stable across transport retries so a mutation is not applied twice. */
  requestId: Schema.String,
  mutation: Schema.String,
  input: Schema.Unknown,
})

export const MutationResult = Schema.Struct({
  output: Schema.Unknown,
  entities: Schema.Array(NormalizedEntity),
})

export const LiveRequirement = Schema.Struct({ requirements: Schema.Array(ReadRequest) })

export const LivePatch = Schema.Struct({
  cursor: Schema.String,
  entity: Schema.String,
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.Unknown),
})

export const Read = Rpc.make('FoldkitRemoteRead', {
  payload: ReadBatch,
  success: ReadBatchResult,
  error: RemoteReadError,
})

export const Mutate = Rpc.make('FoldkitRemoteMutate', {
  payload: MutationRequest,
  success: MutationResult,
  error: RemoteMutationError,
})

export const Live = Rpc.make('FoldkitRemoteLive', {
  payload: LiveRequirement,
  success: LivePatch,
  error: RemoteLiveError,
  stream: true,
})

export const RemoteRpc = RpcGroup.make(Read, Mutate, Live)
