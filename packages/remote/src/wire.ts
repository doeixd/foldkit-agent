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

export const WindowSchema = Schema.Struct({
  first: Schema.optional(Schema.Number),
  last: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
})

export const ReadRequest = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  fields: Schema.Array(Schema.String),
  /** Pagination window per relation field. */
  windows: Schema.optional(Schema.Record(Schema.String, WindowSchema)),
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

export const LiveRequirement = Schema.Struct({
  requirements: Schema.Array(ReadRequest),
  /** Resume cursor; events at or before it are duplicates. */
  after: Schema.Number,
})

export const LiveEdge = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  key: Schema.String,
})

/**
 * A live change. Entity changes update the store; connection changes alter
 * membership and ordering; both carry a per-stream cursor.
 */
export const LiveChange = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('EntityPatched'),
    cursor: Schema.Number,
    entity: Schema.String,
    id: Schema.String,
    values: Schema.Record(Schema.String, Schema.Unknown),
    changed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('EntityDeleted'),
    cursor: Schema.Number,
    entity: Schema.String,
    id: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('ConnectionInsert'),
    cursor: Schema.Number,
    connection: Schema.String,
    position: Schema.Union([Schema.Literal('prepend'), Schema.Literal('append')]),
    edge: LiveEdge,
  }),
  Schema.Struct({
    _tag: Schema.Literal('ConnectionRemove'),
    cursor: Schema.Number,
    connection: Schema.String,
    edge: LiveEdge,
  }),
  Schema.Struct({
    _tag: Schema.Literal('ConnectionInvalidate'),
    cursor: Schema.Number,
    connection: Schema.String,
  }),
])

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
  success: LiveChange,
  error: RemoteLiveError,
  stream: true,
})

export class RemoteQueryError extends Schema.TaggedError<RemoteQueryError>()('RemoteQueryError', {
  message: Schema.String,
}) {}

export const WireBoundary = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('Terminal') }),
  Schema.Struct({ _tag: Schema.Literal('Cursor'), cursor: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('Unknown') }),
])

export const QueryRequest = Schema.Struct({
  query: Schema.String,
  input: Schema.Unknown,
  window: Schema.Struct({
    first: Schema.optional(Schema.Number),
    last: Schema.optional(Schema.Number),
    after: Schema.optional(Schema.String),
    before: Schema.optional(Schema.String),
  }),
})

export const QueryEdge = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  key: Schema.String,
})

export const QueryResult = Schema.Struct({
  edges: Schema.Array(QueryEdge),
  start: WireBoundary,
  end: WireBoundary,
})

export const QueryRpc = Rpc.make('FoldkitRemoteQuery', {
  payload: QueryRequest,
  success: QueryResult,
  error: RemoteQueryError,
})

export const RemoteRpc = RpcGroup.make(Read, Mutate, QueryRpc, Live)
