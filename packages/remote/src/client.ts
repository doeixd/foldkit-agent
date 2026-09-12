/**
 * The transport seam: the `RemoteClient` Effect service, the RPC client it is
 * built from, the wire-to-client reconstructions, and the mutation call.
 */
import { Context, Effect, Layer, Schema, Stream } from 'effect'
import type { Requirement } from 'foldkit-surface'
import { coalesceReads, type CoalesceOptions } from './coalesce.js'
import type { LiveCursor, LiveEvent } from './live.js'
import type { MutationDescriptor } from './mutation.js'
import type { ConnectionChange } from './optimistic.js'
import type { RemoteError } from './remoteData.js'
import {
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  type ConnectionChangeSchema,
  RemoteLiveError,
  RemoteMutationError,
  RemoteProtocolError,
  RemoteQueryError,
  RemoteReadError,
  type LiveChange,
  type LiveRequirement,
} from './wire.js'

/**
 * The transport boundary. `foldkit-remote` never talks to a transport directly;
 * it depends on this Effect service, which a later phase wires to Effect RPC.
 */
export class RemoteClient extends Context.Service<
  RemoteClient,
  {
    readonly read: (
      batch: Schema.Schema.Type<typeof ReadBatch>,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof ReadBatchResult>,
      RemoteReadError | RemoteProtocolError
    >
    readonly query: (
      request: Schema.Schema.Type<typeof QueryRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof QueryResult>, RemoteQueryError>
    readonly mutate: (
      request: Schema.Schema.Type<typeof MutationRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof MutationResult>, RemoteMutationError>
    readonly live: (request: {
      readonly requirements: ReadonlyArray<Requirement>
      readonly after: LiveCursor
    }) => Stream.Stream<LiveEvent, RemoteLiveError | RemoteProtocolError>
  }
>()('foldkit-remote/RemoteClient') {}

/**
 * The methods an Effect RPC client for `RemoteRpc` exposes. `R` is the
 * environment a handler needs; it defaults to `never`, which is what a real
 * transport client satisfies. `RemoteServer.handlers` returns this type with its
 * own `R`, so the two sides cannot drift apart.
 */
export interface RemoteRpcClient<R = never> {
  readonly FoldkitRemoteRead: (
    payload: Schema.Schema.Type<typeof ReadBatch>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof ReadBatchResult>,
    RemoteReadError | RemoteProtocolError,
    R
  >
  readonly FoldkitRemoteQuery: (
    payload: Schema.Schema.Type<typeof QueryRequest>,
  ) => Effect.Effect<Schema.Schema.Type<typeof QueryResult>, RemoteQueryError, R>
  readonly FoldkitRemoteMutate: (
    payload: Schema.Schema.Type<typeof MutationRequest>,
  ) => Effect.Effect<Schema.Schema.Type<typeof MutationResult>, RemoteMutationError, R>
  readonly FoldkitRemoteLive: (
    payload: Schema.Schema.Type<typeof LiveRequirement>,
  ) => Stream.Stream<
    Schema.Schema.Type<typeof LiveChange>,
    RemoteLiveError | RemoteProtocolError,
    R
  >
}

/** Reconstructs the client's `ConnectionChange` from the wire's flattened edge. */
export const connectionChangeOf = (
  change: Schema.Schema.Type<typeof ConnectionChangeSchema>,
): ConnectionChange => {
  const edge = { key: change.edge.key, ref: { entity: change.edge.entity, id: change.edge.id } }
  return change._tag === 'Insert'
    ? { _tag: 'Insert', connection: change.connection, position: change.position, edge }
    : { _tag: 'Remove', connection: change.connection, edge }
}

/** Reconstructs the client's `LiveEvent` from the wire's flattened `LiveChange`. */
export const liveEventOf = (change: Schema.Schema.Type<typeof LiveChange>): LiveEvent => {
  switch (change._tag) {
    case 'EntityPatched':
      return {
        _tag: 'EntityPatched',
        ref: { entity: change.entity, id: change.id },
        values: change.values,
        changed: change.changed,
        cursor: change.cursor,
      }
    case 'EntityDeleted':
      return {
        _tag: 'EntityDeleted',
        ref: { entity: change.entity, id: change.id },
        cursor: change.cursor,
      }
    case 'ConnectionInsert':
      return {
        _tag: 'ConnectionInsert',
        connection: change.connection,
        position: change.position,
        edge: { key: change.edge.key, ref: { entity: change.edge.entity, id: change.edge.id } },
        cursor: change.cursor,
      }
    case 'ConnectionRemove':
      return {
        _tag: 'ConnectionRemove',
        connection: change.connection,
        edge: { key: change.edge.key, ref: { entity: change.edge.entity, id: change.edge.id } },
        cursor: change.cursor,
      }
    case 'ConnectionInvalidate':
      return { _tag: 'ConnectionInvalidate', connection: change.connection, cursor: change.cursor }
  }
}

export const remoteError = (error: {
  readonly _tag: string
  readonly message: string
}): RemoteError => ({
  _tag: error._tag,
  message: error.message,
})

export const coalescedLayer = <E, R>(
  layer: Layer.Layer<RemoteClient, E, R>,
  options: CoalesceOptions = {},
): Layer.Layer<RemoteClient, E, R> =>
  Layer.effect(
    RemoteClient,
    Effect.gen(function* () {
      const client = yield* RemoteClient
      const read = yield* coalesceReads(client.read, options)
      return { ...client, read }
    }),
  ).pipe(Layer.provide(layer))

/**
 * `Remote.mutate` as a standalone effect, so `Remote.mutateInto` can reuse it
 * without the object literal referencing itself.
 */
export const mutateRemote = Effect.fn('Remote.mutate')(function* <
  Name extends string,
  Input,
  Output,
>(mutation: MutationDescriptor<Name, Input, Output>, input: Input, requestId: string) {
  yield* Effect.annotateCurrentSpan({ mutation: mutation.name, requestId })
  const client = yield* RemoteClient
  const encoded = yield* Schema.encodeUnknownEffect(mutation.Input)(input).pipe(
    Effect.catchTag('SchemaError', error =>
      Effect.fail(new RemoteMutationError({ message: error.message })),
    ),
  )
  const result = yield* client.mutate({
    requestId,
    mutation: mutation.name,
    input: encoded,
  })
  const output = yield* Schema.decodeUnknownEffect(mutation.Output)(result.output).pipe(
    Effect.catchTag('SchemaError', error =>
      Effect.fail(new RemoteMutationError({ message: error.message })),
    ),
  )
  return {
    output,
    entities: result.entities,
    connections: (result.connections ?? []).map(connectionChangeOf),
  }
})
