/**
 * The Remote wire: Effect RPC semantics over `effect/unstable/rpc`. Remote owns
 * the message shapes; Effect owns the transport. `Make`ing reads batch, mutations
 * preserve order, and live data is a stream.
 */
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import type { RelationRequirement, Requirement } from 'foldkit-surface'

/**
 * The read/live protocol version. A batch names the version it speaks and the
 * server refuses a mismatch with `RemoteProtocolError`, so a shape change never
 * drifts silently: bump it whenever `ReadRequest` or `LiveRequirement` change.
 */
export const REMOTE_PROTOCOL_VERSION = 3

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

/** The peer speaks another protocol version; nothing was read. */
export class RemoteProtocolError extends Schema.TaggedError<RemoteProtocolError>()(
  'RemoteProtocolError',
  { message: Schema.String, expected: Schema.Number, received: Schema.Number },
) {}

export const WindowSchema = Schema.Struct({
  first: Schema.optional(Schema.Number),
  last: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
})

/** A request may not name more fields of one entity than this; a selection never does. */
export const MAX_FIELDS_PER_REQUEST = 256
/** A selection may not nest relations deeper than this; the wire refuses more. */
export const MAX_RELATION_DEPTH = 8

const Fields = Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_FIELDS_PER_REQUEST))

/**
 * The slice required of a relation's target; the ids come from the parent's
 * refs. Built as `MAX_RELATION_DEPTH` nested structs rather than a recursive
 * schema, so a deeper selection is refused at decode with a schema error.
 */
const relationLevel = (depth: number): Schema.Codec<RelationRequirement, RelationRequirement> => {
  const slice = {
    entity: Schema.String,
    fields: Fields,
    windows: Schema.optional(Schema.Record(Schema.String, WindowSchema)),
  }
  // A struct drops an unknown key silently; the last level refuses one instead.
  return (depth === 0
    ? Schema.Struct({ ...slice, relations: Schema.optionalKey(Schema.Never) })
    : Schema.Struct({
        ...slice,
        relations: Schema.optional(Schema.Record(Schema.String, relationLevel(depth - 1))),
      })) as unknown as Schema.Codec<RelationRequirement, RelationRequirement>
}

export const RelationRequest = relationLevel(MAX_RELATION_DEPTH - 1)

export const ReadRequest: Schema.Codec<Requirement, Requirement> = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  fields: Fields,
  /** Pagination window per relation field. */
  windows: Schema.optional(Schema.Record(Schema.String, WindowSchema)),
  /** The slice required of each relation field's target, resolved in the same read. */
  relations: Schema.optional(Schema.Record(Schema.String, RelationRequest)),
}) as unknown as Schema.Codec<Requirement, Requirement>

export const ReadBatch = Schema.Struct({
  version: Schema.Number,
  requests: Schema.Array(ReadRequest),
})

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

export const LiveEdge = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  key: Schema.String,
})

/** A connection change a mutation confirms: the same facts a live event carries, without a cursor. */
export const ConnectionChangeSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Insert'),
    connection: Schema.String,
    position: Schema.Union([Schema.Literal('prepend'), Schema.Literal('append')]),
    edge: LiveEdge,
  }),
  Schema.Struct({ _tag: Schema.Literal('Remove'), connection: Schema.String, edge: LiveEdge }),
])

export const MutationResult = Schema.Struct({
  output: Schema.Unknown,
  entities: Schema.Array(NormalizedEntity),
  /** Connection changes the mutation made, applied alongside its entity patches. */
  connections: Schema.optional(Schema.Array(ConnectionChangeSchema)),
})

export const LiveRequirement = Schema.Struct({
  version: Schema.Number,
  requirements: Schema.Array(ReadRequest),
  /** Resume cursor; events at or before it are duplicates. */
  after: Schema.Number,
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
  error: Schema.Union([RemoteReadError, RemoteProtocolError]),
})

export const Mutate = Rpc.make('FoldkitRemoteMutate', {
  payload: MutationRequest,
  success: MutationResult,
  error: RemoteMutationError,
})

export const Live = Rpc.make('FoldkitRemoteLive', {
  payload: LiveRequirement,
  success: LiveChange,
  error: Schema.Union([RemoteLiveError, RemoteProtocolError]),
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
