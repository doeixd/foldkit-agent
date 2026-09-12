/**
 * `foldkit-remote` — normalized application-facing server state.
 *
 * The pure core (entities, selections, the store, the planner, connections,
 * live classification, optimistic layers) performs no I/O. The `Remote.*`
 * helpers that read or mutate go through the `RemoteClient` Effect service.
 */
import { Effect, Layer, Result, Schema, Stream } from 'effect'
import type { Duration } from 'effect'
import type { EntryWithoutKeepAlive } from 'foldkit/subscription'
import {
  Requirement,
  type Contract,
  type ModelRef,
  type Projection,
  type Surface,
} from 'foldkit-surface'
import {
  RemoteClient,
  coalescedLayer,
  liveEventOf,
  mutateRemote,
  remoteError,
  type RemoteRpcClient,
} from './client.js'
import { emptyConnection, type Edge } from './connection.js'
import type { EntityDescriptor } from './entity.js'
import { inspectEntity, inspectRemote } from './inspect.js'
import type { LiveCursor } from './live.js'
import {
  initialRemoteModel,
  remoteMessageSchema,
  remoteModelSchema,
  retentionRootsSchema,
  updateRemote,
  writeRead,
  type RemoteMessage,
  type RemoteModel,
} from './model.js'
import type { MutationDescriptor } from './mutation.js'
import {
  connectionIdentity,
  visibleItems,
  visibleStore,
  type ConnectionIdentity,
  type OptimisticState,
  type OptimisticOperation,
} from './optimistic.js'
import { plan, type PlanOptions } from './plan.js'
import { RemotePolicy } from './policy.js'
import type { QueryDescriptor, QueryRef } from './query.js'
import { remoteDataSchema, type RemoteData } from './remoteData.js'
import type { RetentionRoots } from './retain.js'
import { assemble, relationOf, type Selection } from './selection.js'
import { entityKey, isTombstone, type EntityStore } from './store.js'
import {
  QueryResult,
  ReadRequest,
  REMOTE_PROTOCOL_VERSION,
  RemoteLiveError,
  RemoteProtocolError,
  RemoteQueryError,
  RemoteRpc,
} from './wire.js'
import type { CoalesceOptions } from './coalesce.js'

export * from './client.js'
export * from './coalesce.js'
export * from './connection.js'
export * from './entity.js'
export * from './inspect.js'
export * from './live.js'
export * from './model.js'
export * from './mutation.js'
export * from './optimistic.js'
export * from './persistence.js'
export * from './plan.js'
export * from './policy.js'
export * from './query.js'
export * from './relation.js'
export * from './remoteData.js'
export * from './retain.js'
export * from './selection.js'
export * from './store.js'
export * from './wire.js'

type EntityName<D> = D extends EntityDescriptor<infer Name, any> ? Name : never

export interface RemoteDescriptor<
  Entities extends readonly EntityDescriptor<any, any>[] = readonly EntityDescriptor<any, any>[],
  Queries extends readonly QueryDescriptor<any, any, any>[] = readonly QueryDescriptor<
    any,
    any,
    any
  >[],
  Mutations extends readonly MutationDescriptor<any, any, any>[] = readonly MutationDescriptor<
    any,
    any,
    any
  >[],
> {
  readonly entities: Entities
  readonly queries: Queries
  readonly mutations: Mutations
  readonly Model: Schema.Schema<RemoteModel>
  readonly initial: RemoteModel
  readonly Message: Schema.Schema<RemoteMessage>
  readonly update: (model: RemoteModel, message: RemoteMessage) => RemoteModel
  readonly rpc: typeof RemoteRpc
  /** Name-keyed lookups built from the declared entities, queries, and mutations. */
  readonly registry: {
    readonly entities: ReadonlyMap<string, EntityDescriptor<any, any>>
    readonly queries: ReadonlyMap<string, QueryDescriptor<any, any, any>>
    readonly mutations: ReadonlyMap<string, MutationDescriptor<any, any, any>>
  }
}

declare const boundRemoteNames: unique symbol

export interface BoundRemote<AppModel, Store extends RemoteModel, Names extends string = string> {
  readonly definition: RemoteDescriptor
  readonly store: ModelRef<AppModel, Store>
  /** For `Module`: owns the store's Model path. */
  readonly contract: Contract
  /** Phantom: the entity names this Remote definition registers. */
  readonly [boundRemoteNames]?: Names
}

/**
 * The store a read or plan sees: the base with every pending optimistic layer
 * applied, so a request's patches show until it settles and a temporary id is
 * not planned as a fetch.
 */
const storeOf = <AppModel, Store extends RemoteModel, Names extends string>(
  bound: BoundRemote<AppModel, Store, Names>,
  model: AppModel,
): EntityStore => {
  const remote = bound.store.get(model)
  return visibleStoreOf(remote.entities, remote.optimistic)
}

// The visible store is recomputed only when the base store or the layers
// change, so reads and plans across renders of one Model share it.
const visibleStores = new WeakMap<OptimisticState, WeakMap<EntityStore, EntityStore>>()

const visibleStoreOf = (entities: EntityStore, optimistic: OptimisticState): EntityStore => {
  let byStore = visibleStores.get(optimistic)
  if (byStore === undefined) {
    byStore = new WeakMap()
    visibleStores.set(optimistic, byStore)
  }
  let visible = byStore.get(entities)
  if (visible === undefined) {
    visible = visibleStore(entities, optimistic)
    byStore.set(entities, visible)
  }
  return visible
}

export interface MutateOptions {
  /** What the request changes before the server answers; released when it settles. */
  readonly optimistic?: ReadonlyArray<OptimisticOperation> | undefined
}

/** The default `toMessage`: the application reduces `RemoteMessage` itself. */
const identityMessage = (message: RemoteMessage): RemoteMessage => message

export interface RetainOptions {
  /** The query connections the application shows, by `QueryRef` or identity. */
  readonly connections?: ReadonlyArray<ConnectionIdentity> | undefined
  /** How long the roots must be stable before collecting; default none. */
  readonly grace?: Duration.Input | undefined
}

/** How `Remote.observe` and `Remote.prefetch` treat fields the store already holds. */
export interface ObserveOptions {
  /** Default `RemotePolicy.cacheFirst`. */
  readonly policy?: RemotePolicy | undefined
  /** The clock a refreshing policy reads; default `Date.now`. */
  readonly now?: (() => number) | undefined
}

export interface LiveOptions {
  /** The clock `LiveReceived` stamps events with; default `Date.now`. */
  readonly now?: (() => number) | undefined
}

/** A stable key for a live subscription's requirement set. */
const liveStreamKey = (requirements: readonly Requirement[]): string =>
  requirements
    .map(
      requirement =>
        `${entityKey(requirement.entity, requirement.id)}:${[...requirement.fields].sort().join(',')}`,
    )
    .sort()
    .join('|')

export const Remote = {
  /**
   * Declares a Remote domain: its entities, queries, and mutations, plus the
   * submodel the application embeds and reduces.
   */
  make: <
    const Entities extends readonly EntityDescriptor<any, any>[],
    const Queries extends readonly QueryDescriptor<any, any, any>[] = readonly QueryDescriptor<
      any,
      any,
      any
    >[],
    const Mutations extends readonly MutationDescriptor<any, any, any>[] =
      readonly MutationDescriptor<any, any, any>[],
  >(config: {
    readonly entities: Entities
    readonly queries?: Queries
    readonly mutations?: Mutations
  }): RemoteDescriptor<Entities, Queries, Mutations> => ({
    entities: config.entities,
    queries: (config.queries ?? []) as unknown as Queries,
    mutations: (config.mutations ?? []) as unknown as Mutations,
    Model: remoteModelSchema(),
    initial: initialRemoteModel,
    Message: remoteMessageSchema,
    update: updateRemote,
    rpc: RemoteRpc,
    registry: {
      entities: new Map(config.entities.map(entity => [entity.name, entity])),
      queries: new Map((config.queries ?? []).map(query => [query.name, query])),
      mutations: new Map((config.mutations ?? []).map(mutation => [mutation.name, mutation])),
    },
  }),

  /**
   * Binds a Remote domain to its store's location in the application Model. The
   * registered entity names are carried on the returned value, so `Remote.select`
   * rejects a selection for an entity this domain never declared.
   */
  at: <
    AppModel,
    Store extends RemoteModel,
    Entities extends readonly EntityDescriptor<any, any>[],
    Queries extends readonly QueryDescriptor<any, any, any>[],
    Mutations extends readonly MutationDescriptor<any, any, any>[],
  >(
    definition: RemoteDescriptor<Entities, Queries, Mutations>,
    store: ModelRef<AppModel, Store>,
  ): BoundRemote<AppModel, Store, EntityName<Entities[number]>> => ({
    definition,
    store,
    contract: {
      kind: 'remote',
      name: store.dependency.join('.') || 'remote',
      // A generated field reference knows its application and its path; a raw
      // optic (`ModelRef.fromOptic`) knows neither, so it claims nothing.
      owner: (store as { readonly owner?: object }).owner,
      owns: store.dependency.length === 0 ? [] : [store.dependency],
      observes: store.dependency.length === 0 ? [] : [store.dependency],
      messages: [],
      requirements: [],
    },
  }),

  /**
   * A Projection node that reads a `RemoteData` value out of the store. The id
   * is supplied by the caller, usually from a Surface's params. The assembled
   * value is decoded against the Selection, so malformed server data surfaces
   * as `Failed` instead of being asserted into `Value`. A present value with a
   * stale field reads as `Refreshing`: an observer is refetching it.
   */
  select:
    <AppModel, Store extends RemoteModel, Names extends string, Value, Name extends Names>(
      bound: BoundRemote<AppModel, Store, Names>,
      selection: Selection<Value, Name, 'entity'>,
    ) =>
    (id: string): Projection<AppModel, RemoteData<Value>> => ({
      Model: remoteDataSchema(selection.schema),
      dependencies: [],
      requirements: [{ ...relationOf(selection), id }],
      read: (root: AppModel): RemoteData<Value> => {
        const store = storeOf(bound, root)
        const key = entityKey(selection.entity, id)
        if (isTombstone(store, key)) return { _tag: 'NotFound' }
        const assembled = assemble(store, key, relationOf(selection))
        if (assembled === undefined) return { _tag: 'Initial' }
        const decoded = Schema.decodeUnknownResult(selection.schema)(assembled.values)
        return Result.isFailure(decoded)
          ? { _tag: 'Failed', error: { _tag: 'DecodeError', message: decoded.failure.message } }
          : assembled.refreshing
            ? { _tag: 'Refreshing', value: decoded.success }
            : { _tag: 'Ready', value: decoded.success }
      },
    }),

  /**
   * The pure plan for a projection against a Model: the requirements its
   * remote store does not satisfy, under `options` (freshness, force). A
   * Surface's projection is `surface.projection(params)`.
   */
  plan: <AppModel, Store extends RemoteModel, Value>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    projection: Projection<AppModel, Value>,
    options?: PlanOptions,
  ): ReadonlyArray<Requirement> => plan(storeOf(bound, model), projection.requirements, options),

  /**
   * The store reads see: the base store under the pending optimistic layers.
   * One store is shared by every read and plan of a Model whose remote state
   * has not changed.
   */
  storeOf: <AppModel, Store extends RemoteModel>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
  ): EntityStore => storeOf(bound, model),

  /**
   * Executes the plan against the `RemoteClient` and returns a new store. Used
   * for SSR route prefetch, hover prefetch, and tests. Never called during render.
   * `policy` decides what a present field means (default cache-first); `now`
   * is the clock it reads, so the planner itself stays pure and time-injected.
   */
  prefetch: Effect.fn('Remote.prefetch')(function* <AppModel, Store extends RemoteModel, Value>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    projection: Projection<AppModel, Value>,
    options: ObserveOptions = {},
  ) {
    const store = storeOf(bound, model)
    const { policy = RemotePolicy.cacheFirst, now = Date.now } = options
    const at = now()
    const missing = plan(store, projection.requirements, RemotePolicy.toPlan(policy, at))
    if (missing.length === 0) return store
    yield* Effect.annotateCurrentSpan('requirementCount', missing.length)
    const client = yield* RemoteClient
    const result = yield* client.read({ version: REMOTE_PROTOCOL_VERSION, requests: missing })
    return writeRead(store, missing, result, at)
  }),

  /**
   * Writes a read result into the store, recording each field's applied window.
   * `requests` are the planned requirements the result answers.
   */
  writeRead,

  /**
   * Adapts an Effect RPC client for `RemoteRpc` to `RemoteClient`, so an
   * application provides the transport's RPC layer instead of writing the
   * `LiveChange`-to-`LiveEvent` mapping by hand.
   */
  clientLayer: <R = never>(
    client: RemoteRpcClient<R>,
    options: CoalesceOptions = {},
  ): Layer.Layer<RemoteClient, never, R> =>
    coalescedLayer(
      Layer.effect(
        RemoteClient,
        Effect.gen(function* () {
          // What the RPC client needs (a database under in-process handlers,
          // nothing under a transport) is supplied once, when the layer is built.
          const context = yield* Effect.context<R>()
          return {
            read: batch => client.FoldkitRemoteRead(batch).pipe(Effect.provideContext(context)),
            query: request =>
              client.FoldkitRemoteQuery(request).pipe(Effect.provideContext(context)),
            mutate: request =>
              client.FoldkitRemoteMutate(request).pipe(Effect.provideContext(context)),
            live: ({ requirements, after }) =>
              client
                .FoldkitRemoteLive({ version: REMOTE_PROTOCOL_VERSION, requirements, after })
                .pipe(Stream.map(liveEventOf), Stream.provideContext(context)),
          }
        }),
      ),
      options,
    ),

  /**
   * Wraps a `RemoteClient` layer so its reads coalesce: requirements issued
   * together become one batch, and a requirement already in flight is joined.
   * `Remote.clientLayer` applies this; use it on a hand-written client.
   */
  coalesced: coalescedLayer,

  /**
   * A Foldkit Subscription entry that keeps the cache to what the active
   * Surfaces reach. `projections` are the ones the application observes (the
   * same it passes to `Remote.observe`), `connections` the query connections
   * it shows; anything else is collected once the roots have been stable for
   * `grace`, so a route transition that comes straight back does not thrash.
   */
  retain: <AppModel, Message = RemoteMessage>(
    projections: ReadonlyArray<Projection<AppModel, unknown>>,
    toMessage: (message: RemoteMessage) => Message = identityMessage as never,
    options: RetainOptions = {},
  ): EntryWithoutKeepAlive<AppModel, Message, RetentionRoots, never> => {
    const roots: RetentionRoots = {
      requirements: Requirement.merge(projections.flatMap(projection => projection.requirements)),
      connections: [...new Set((options.connections ?? []).map(connectionIdentity))].sort(),
    }
    return {
      dependenciesSchema: retentionRootsSchema,
      modelToDependencies: () => roots,
      dependenciesToStream: current =>
        Stream.fromEffect(
          Effect.succeed(toMessage({ _tag: 'RetentionChanged', roots: current })).pipe(
            Effect.delay(options.grace ?? 0),
          ),
        ),
    }
  },

  /**
   * Runs a `Query` through `RemoteClient`, encoding its input from the ref.
   * Pair the result with `Remote.queryMessage` to merge the page into the Model.
   */
  query: Effect.fn('Remote.query')(function* <Name extends string, Input>(
    ref: QueryRef<Name, Input>,
  ) {
    const client = yield* RemoteClient
    const input = yield* Schema.encodeUnknownEffect(ref.Input)(ref.input).pipe(
      Effect.catchTag('SchemaError', error =>
        Effect.fail(new RemoteQueryError({ message: error.message })),
      ),
    )
    return yield* client.query({ query: ref.query, input, window: ref.window })
  }),

  /** The `RemoteMessage` that merges a query page into its connection. */
  queryMessage: <Name extends string, Input>(
    ref: QueryRef<Name, Input>,
    result: Schema.Schema.Type<typeof QueryResult>,
  ): RemoteMessage => ({
    _tag: 'ConnectionMerged',
    connection: ref.identity,
    page: {
      edges: result.edges.map(edge => ({
        key: edge.key,
        ref: { entity: edge.entity, id: edge.id },
      })),
      start: result.start,
      end: result.end,
    },
  }),

  /**
   * The edges a connection shows: its server-known region with pending and
   * confirmed overlays placed around it, minus removed edges and edges whose
   * target is a tombstone.
   */
  visibleItems: (model: RemoteModel, connection: ConnectionIdentity): ReadonlyArray<Edge> => {
    const identity = connectionIdentity(connection)
    return visibleItems(
      model.connections[identity] ?? emptyConnection,
      identity,
      model.optimistic.overlays,
      model.entities,
    )
  },

  /** A pure, serializable view of the whole cache. */
  inspect: inspectRemote,

  /** A pure, serializable view of one entity, or `undefined` if unknown. */
  inspectEntity,

  /**
   * Runs a mutation through `RemoteClient`, decoding its typed Output and
   * returning the result's normalized patches so the caller can reconcile them
   * through `Remote.update`'s `MutationSucceeded` (or `Remote.mutateInto`).
   */
  mutate: mutateRemote,

  /**
   * Runs a mutation and reconciles its patches into a `RemoteModel` in one step,
   * returning the new model alongside the typed Output. The model-level form of
   * `MutationStarted` → `RemoteClient.mutate` → `MutationSucceeded`; in an
   * application the three are `update` (with `optimistic`), a Command, and the
   * Message the Command returns, so the optimistic operations show meanwhile.
   */
  mutateInto: Effect.fn('Remote.mutateInto')(function* <
    Name extends string,
    Input,
    Output,
    AppModel,
    Store extends RemoteModel,
  >(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    mutation: MutationDescriptor<Name, Input, Output>,
    input: Input,
    requestId: string,
    options: MutateOptions = {},
  ) {
    const started = updateRemote(bound.store.get(model), {
      _tag: 'MutationStarted',
      requestId,
      ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }),
    })
    const outcome = yield* mutateRemote(mutation, input, requestId)
    const settled = updateRemote(started, {
      _tag: 'MutationSucceeded',
      requestId,
      entities: outcome.entities,
      connections: outcome.connections,
    })
    return {
      output: outcome.output,
      model: bound.store.set(model, settled as Store),
    }
  }),

  /**
   * A Foldkit Subscription entry that plans a Surface's missing fields from the
   * Model and fetches them through `RemoteClient`, emitting a `RemoteMessage`
   * per outcome. Wrap it in an application Message (`toMessage`) and reduce it
   * with the domain's `update`. Under a refreshing `policy` the entry first
   * emits `RefreshStarted`, so the fields being refetched read as `Refreshing`
   * while the request is pending.
   */
  observe: <
    AppModel,
    Store extends RemoteModel,
    Names extends string,
    Model,
    SurfaceMessage,
    Params,
    Message = RemoteMessage,
  >(
    bound: BoundRemote<AppModel, Store, Names>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (message: RemoteMessage) => Message = identityMessage as never,
    options: ObserveOptions = {},
  ): EntryWithoutKeepAlive<
    AppModel,
    Message,
    { readonly requirements: ReadonlyArray<Requirement> },
    RemoteClient
  > => {
    const { policy = RemotePolicy.cacheFirst, now = Date.now } = options
    const read = (requirements: ReadonlyArray<Requirement>) =>
      Effect.gen(function* () {
        const client = yield* RemoteClient
        const at = now()
        const result = yield* Effect.result(
          client.read({ version: REMOTE_PROTOCOL_VERSION, requests: requirements }),
        )
        return Result.isFailure(result)
          ? toMessage({
              _tag: 'ReadFailed',
              requests: requirements,
              error: remoteError(result.failure),
            })
          : toMessage({
              _tag: 'ReadReceived',
              requests: requirements,
              result: result.success,
              now: at,
            })
      })
    return {
      dependenciesSchema: Schema.Struct({
        requirements: Schema.Array(ReadRequest),
      }),
      modelToDependencies: model => ({
        requirements: plan(
          storeOf(bound, model),
          surface.projection(params).requirements,
          RemotePolicy.toPlan(policy, now()),
        ),
      }),
      dependenciesToStream: ({ requirements }) =>
        requirements.length === 0
          ? Stream.empty
          : Stream.concat(
              RemotePolicy.refreshes(policy)
                ? Stream.succeed(toMessage({ _tag: 'RefreshStarted', requests: requirements }))
                : Stream.empty,
              Stream.fromEffect(read(requirements)),
            ),
    }
  },

  /**
   * A Foldkit Subscription entry that consumes the live stream for a Surface's
   * requirements, emitting a `LiveReceived` per event and a `ReadFailed` when
   * the stream breaks (including `ResumeUnavailable`). The resume cursor is read
   * from `RemoteModel.live`, so the application tracks no cursor of its own.
   */
  live: <
    AppModel,
    Store extends RemoteModel,
    Names extends string,
    Model,
    SurfaceMessage,
    Params,
    Message = RemoteMessage,
  >(
    bound: BoundRemote<AppModel, Store, Names>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (message: RemoteMessage) => Message = identityMessage as never,
    options: LiveOptions = {},
  ): EntryWithoutKeepAlive<
    AppModel,
    Message,
    { readonly requirements: ReadonlyArray<Requirement>; readonly cursor: LiveCursor },
    RemoteClient
  > => ({
    dependenciesSchema: Schema.Struct({
      requirements: Schema.Array(ReadRequest),
      cursor: Schema.Number,
    }),
    modelToDependencies: model => {
      const requirements = surface.projection(params).requirements
      const stream = liveStreamKey(requirements)
      return {
        requirements,
        cursor: bound.store.get(model).live[stream]?.cursor ?? 0,
      }
    },
    dependenciesToStream: ({ requirements, cursor }) =>
      requirements.length === 0
        ? Stream.empty
        : Stream.unwrap(
            Effect.gen(function* () {
              const client = yield* RemoteClient
              return client.live({ requirements, after: cursor })
            }),
          ).pipe(
            Stream.map(event =>
              toMessage({
                _tag: 'LiveReceived',
                stream: liveStreamKey(requirements),
                event,
                now: (options.now ?? Date.now)(),
              }),
            ),
            Stream.catchIf(
              (_error): _error is RemoteLiveError | RemoteProtocolError => true,
              error =>
                Stream.succeed(
                  toMessage({
                    _tag: 'ReadFailed',
                    requests: requirements,
                    error: remoteError(error),
                  }),
                ),
            ),
          ),
  }),
}
