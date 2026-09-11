/**
 * `foldkit-remote` — normalized application-facing server state.
 *
 * The pure core (entities, selections, the store, the planner, connections,
 * live classification, optimistic layers) performs no I/O. The `Remote.*`
 * helpers that read or mutate go through the `RemoteClient` Effect service.
 */
import { Context, Effect, Option, Result, Schema, SchemaGetter, Stream } from 'effect'
import type { EntryWithoutKeepAlive } from 'foldkit/subscription'
import type { ModelRef, Projection, Requirement, Surface } from 'foldkit-surface'
import { emptyConnection, merge, type Connection, type Segment } from './connection.js'
import {
  addLayer,
  emptyOptimistic,
  removeLayer,
  type EntityLayer,
  type Optimistic,
} from './optimistic.js'
import {
  applyConnectionEvent,
  applyEntityEvent,
  emptyLiveState,
  type LiveCursor,
  type LiveEvent,
  type LiveState,
} from './live.js'
import {
  beginMutation,
  emptyMutationState,
  failMutation,
  reconcileMutation,
  type MutationState,
  type NormalizedPatch,
} from './mutation.js'
import {
  entityKey,
  emptyStore,
  isTombstone,
  readField,
  writeEntity,
  type EntityStore,
} from './store.js'
import { plan, windowKey, type PlanFreshness } from './plan.js'
import {
  MutationRequest,
  MutationResult,
  NormalizedEntity,
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  ReadRequest,
  RemoteLiveError,
  RemoteMutationError,
  RemoteQueryError,
  RemoteReadError,
  RemoteRpc,
} from './wire.js'
import type { LivePolicy, QueryDescriptor, QueryWindow } from './query.js'

type AnySchema = Schema.Schema<unknown>

export * from './store.js'
export * from './plan.js'
export * from './connection.js'
export * from './query.js'
export * from './mutation.js'
export * from './optimistic.js'
export * from './live.js'
export * from './persistence.js'
export * from './wire.js'

// ===========================================================================
// Entity
// ===========================================================================

declare const entityRefFields: unique symbol

/**
 * A normalized reference to an entity. `F` is a phantom carrying the entity's
 * fields so `Entity.patch` can type its patch; it is absent at runtime.
 */
export interface EntityRef<
  Name extends string,
  F extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly entity: Name
  readonly id: string
  readonly [entityRefFields]?: F
}

export interface EntityDescriptor<Name extends string, F extends Schema.Struct.Fields> {
  readonly name: Name
  readonly schema: Schema.Struct<F>
  readonly fields: F
  readonly ref: (id: Schema.Schema.Type<F['id']>) => EntityRef<Name, F>
}

const encodeRef = (ref: { readonly entity: string; readonly id: string }): string =>
  `${ref.entity}:${ref.id}`

const decodeRef = (encoded: string): { readonly entity: string; readonly id: string } => {
  const separator = encoded.indexOf(':')
  return separator === -1
    ? { entity: encoded, id: '' }
    : { entity: encoded.slice(0, separator), id: encoded.slice(separator + 1) }
}

/**
 * Relations are **references**, never inline target schemas: a ref cannot
 * reconstruct a full entity, and dereferencing is a store concern. Because the
 * target schema is not inlined, recursive relations cannot arise through the
 * schema graph.
 */
const refCodec = <Name extends string, F extends Schema.Struct.Fields>(): Schema.Codec<
  EntityRef<Name, F>,
  string
> =>
  Schema.Struct({ entity: Schema.String, id: Schema.String }).pipe(
    Schema.encodeTo(Schema.String, {
      decode: SchemaGetter.transform(decodeRef),
      encode: SchemaGetter.transform(encodeRef),
    }),
  ) as unknown as Schema.Codec<EntityRef<Name, F>, string>

export interface EntityPatch<Name extends string, F extends Schema.Struct.Fields> {
  readonly entity: Name
  readonly id: string
  readonly values: Partial<Schema.Struct.Type<F>>
}

/**
 * One authoritative page of a paginated relation: refs (never inline entities)
 * plus whether more exist. The adapter does not hold segmentation state; the
 * client merges pages.
 */
export interface RefPage<
  Name extends string,
  F extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  readonly refs: ReadonlyArray<EntityRef<Name, F>>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

const refPageCodec = <Name extends string, F extends Schema.Struct.Fields>(): Schema.Codec<
  RefPage<Name, F>,
  {
    readonly refs: ReadonlyArray<string>
    readonly hasNext: boolean
    readonly hasPrevious: boolean
  }
> =>
  Schema.Struct({
    refs: Schema.Array(refCodec<Name, F>()),
    hasNext: Schema.Boolean,
    hasPrevious: Schema.Boolean,
  }) as unknown as Schema.Codec<
    RefPage<Name, F>,
    {
      readonly refs: ReadonlyArray<string>
      readonly hasNext: boolean
      readonly hasPrevious: boolean
    }
  >

export const Entity = {
  make: <
    const Name extends string,
    const F extends Schema.Struct.Fields & { readonly id: Schema.Schema<unknown> },
  >(
    name: Name,
    schema: Schema.Struct<F>,
  ): EntityDescriptor<Name, F> => ({
    name,
    schema,
    fields: schema.fields,
    ref: id => ({ entity: name, id: String(id) }) as EntityRef<Name, F>,
  }),

  /** A relation to a known entity, decoded as a reference. */
  ref: <Name extends string, F extends Schema.Struct.Fields>(
    _entity: EntityDescriptor<Name, F>,
  ): Schema.Codec<EntityRef<Name, F>, string> => refCodec<Name, F>(),

  /** A relation by name, for recursive or forward references. */
  refTo: <Name extends string>(_name: Name): Schema.Codec<EntityRef<Name>, string> =>
    refCodec<Name, Schema.Struct.Fields>(),

  /**
   * The wire key a relation field carries (`"Entity:id"`). Adapters that read a
   * foreign key emit this so the ref codec can decode it on the client.
   */
  refKey: (ref: { readonly entity: string; readonly id: string }): string => encodeRef(ref),

  /** Splits a ref key back into its entity and id. */
  refParts: (key: string): { readonly entity: string; readonly id: string } => decodeRef(key),

  /** A relation value of one authoritative page of refs. */
  refPage: <Name extends string, F extends Schema.Struct.Fields>(
    _entity: EntityDescriptor<Name, F>,
  ): Schema.Codec<
    RefPage<Name, F>,
    {
      readonly refs: ReadonlyArray<string>
      readonly hasNext: boolean
      readonly hasPrevious: boolean
    }
  > => refPageCodec<Name, F>(),

  patch: <Name extends string, F extends Schema.Struct.Fields>(
    ref: EntityRef<Name, F>,
    patch: Partial<Schema.Struct.Type<F>>,
  ): EntityPatch<Name, F> => ({ entity: ref.entity, id: ref.id, values: patch }),
}

// ===========================================================================
// Selection
// ===========================================================================

export interface Selection<Value, Name extends string = string> {
  readonly entity: Name
  readonly fields: readonly string[]
  /** A pure codec: entity fields carry no decoding or encoding services. */
  readonly schema: Schema.Codec<Value, unknown, never, never>
  /** Pagination windows for nested relation fields, keyed by field name. */
  readonly connections?: Readonly<Record<string, QueryWindow>> | undefined
  /** Present when this selection is itself a paginated relation. */
  readonly window?: QueryWindow | undefined
}

type SelectionOf<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: true | Selection<unknown>
}

type SelectionValue<F extends Schema.Struct.Fields, Sel> = {
  readonly [K in keyof Sel & keyof F]: Sel[K] extends true
    ? Schema.Schema.Type<F[K]>
    : Sel[K] extends Selection<infer V>
      ? V
      : never
}

export const Selection = {
  make: <Name extends string, F extends Schema.Struct.Fields, const Sel extends SelectionOf<F>>(
    entity: EntityDescriptor<Name, F>,
    selection: Sel,
  ): Selection<SelectionValue<F, Sel>, Name> => {
    const picked: Record<string, AnySchema> = {}
    const connections: Record<string, QueryWindow> = {}
    for (const key of Object.keys(selection)) {
      const choice = (selection as Record<string, unknown>)[key]
      if (choice === true) {
        picked[key] = entity.fields[key] as AnySchema
        continue
      }
      const nested = choice as Selection<unknown>
      picked[key] = nested.schema as AnySchema
      if (nested.window !== undefined) connections[key] = nested.window
    }
    return {
      entity: entity.name,
      fields: Object.keys(selection),
      schema: Schema.Struct(picked) as unknown as Schema.Codec<
        SelectionValue<F, Sel>,
        unknown,
        never,
        never
      >,
      ...(Object.keys(connections).length === 0 ? {} : { connections }),
    }
  },

  /** A paginated relation: one page of refs to `entity`, with a window. */
  connection: <Name extends string, F extends Schema.Struct.Fields>(
    entity: EntityDescriptor<Name, F>,
    window: QueryWindow,
  ): Selection<RefPage<Name, F>, Name> => ({
    entity: entity.name,
    fields: [],
    schema: Entity.refPage(entity) as unknown as Schema.Codec<
      RefPage<Name, F>,
      unknown,
      never,
      never
    >,
    window,
  }),
}

// ===========================================================================
// RemoteData and the Remote scope
// ===========================================================================

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

export interface RemoteError {
  readonly _tag: string
  readonly message: string
}

export type RemoteData<A> =
  | { readonly _tag: 'Initial' }
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly value: A }
  | { readonly _tag: 'Refreshing'; readonly value: A }
  | { readonly _tag: 'Failed'; readonly error: RemoteError; readonly previous?: A }
  | { readonly _tag: 'NotFound' }

const remoteErrorSchema = Schema.Struct({ _tag: Schema.String, message: Schema.String })

/** A `RemoteData` schema, so a projection that reads remote state is typed. */
const remoteDataSchema = <A>(value: Schema.Schema<A>): Schema.Schema<RemoteData<A>> =>
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literal('Initial') }),
    Schema.Struct({ _tag: Schema.Literal('Loading') }),
    Schema.Struct({ _tag: Schema.Literal('Ready'), value }),
    Schema.Struct({ _tag: Schema.Literal('Refreshing'), value }),
    Schema.Struct({
      _tag: Schema.Literal('Failed'),
      error: remoteErrorSchema,
      previous: Schema.optional(value),
    }),
    Schema.Struct({ _tag: Schema.Literal('NotFound') }),
  ]) as unknown as Schema.Schema<RemoteData<A>>

export const RemoteData = {
  /**
   * The `RemoteData` schema for a value schema. Exposed so a `RemoteData` can
   * be embedded in a hand-written Model schema, not only through `Remote.select`.
   */
  schema: <A>(value: Schema.Schema<A>): Schema.Schema<RemoteData<A>> => remoteDataSchema(value),

  /** Exhaustive: omitting a state is a compile error. */
  match: <A, R>(
    data: RemoteData<A>,
    cases: {
      readonly Initial: () => R
      readonly Loading: () => R
      readonly Ready: (value: A) => R
      readonly Refreshing: (value: A) => R
      readonly Failed: (error: RemoteError, previous: Option.Option<A>) => R
      readonly NotFound: () => R
    },
  ): R => {
    switch (data._tag) {
      case 'Initial':
        return cases.Initial()
      case 'Loading':
        return cases.Loading()
      case 'Ready':
        return cases.Ready(data.value)
      case 'Refreshing':
        return cases.Refreshing(data.value)
      case 'Failed':
        return cases.Failed(
          data.error,
          data.previous === undefined ? Option.none() : Option.some(data.previous),
        )
      case 'NotFound':
        return cases.NotFound()
    }
  },

  map: <A, B>(data: RemoteData<A>, f: (value: A) => B): RemoteData<B> => {
    switch (data._tag) {
      case 'Ready':
        return { _tag: 'Ready', value: f(data.value) }
      case 'Refreshing':
        return { _tag: 'Refreshing', value: f(data.value) }
      case 'Failed':
        return data.previous === undefined
          ? { _tag: 'Failed', error: data.error }
          : { _tag: 'Failed', error: data.error, previous: f(data.previous) }
      default:
        return data
    }
  },
}

/**
 * The Remote scope's slot in the application Model. `Remote.make` returns a
 * schema and an `update` for this shape, so the normalized cache is an ordinary
 * Foldkit Submodel: reads, mutation results, live events, and optimistic layers
 * all reconcile through `Remote.update`.
 */
export interface RemoteModel {
  /** Entity values, presence, staleness, tombstones, and applied windows. */
  readonly entities: EntityStore
  /** Normalized ordered connections, keyed by connection identity. */
  readonly connections: Readonly<Record<string, Connection>>
  /** Optimistic entity layers and connection overlays over the base store. */
  readonly optimistic: Optimistic
  /** Live cursor and boundary state, keyed by the subscription's stream key. */
  readonly live: Readonly<Record<string, LiveState>>
  /** Mutation pending/applied/failed ledger. */
  readonly mutations: MutationState
  /** Streams whose live cursor fell behind; the caller should resync or refetch. */
  readonly gaps: ReadonlySet<string>
}

export const initialRemoteModel: RemoteModel = {
  entities: emptyStore,
  connections: {},
  optimistic: emptyOptimistic,
  live: {},
  mutations: emptyMutationState,
  gaps: new Set(),
}

/** The entity store and the mutation ledger are runtime values, not wire shapes. */
const runtimeSchema = Schema.Unknown

const remoteModelSchema = (): Schema.Schema<RemoteModel> =>
  Schema.Struct({
    entities: runtimeSchema,
    connections: Schema.Record(Schema.String, runtimeSchema),
    optimistic: runtimeSchema,
    live: Schema.Record(Schema.String, runtimeSchema),
    mutations: runtimeSchema,
    gaps: runtimeSchema,
  }) as unknown as Schema.Schema<RemoteModel>

/**
 * The Remote submodel's Messages. The four producers of new facts — a read
 * batch, a mutation result, a live event, and an optimistic layer — all reduce
 * to `RemoteModel` through `Remote.update`.
 */
export type RemoteMessage =
  | {
      readonly _tag: 'ReadReceived'
      readonly requests: readonly Requirement[]
      readonly result: Schema.Schema.Type<typeof ReadBatchResult>
      readonly now: number
    }
  | {
      readonly _tag: 'ReadFailed'
      readonly requests: readonly Requirement[]
      readonly error: RemoteError
    }
  | { readonly _tag: 'MutationStarted'; readonly requestId: string }
  | {
      readonly _tag: 'MutationSucceeded'
      readonly requestId: string
      readonly entities: readonly NormalizedPatch[]
    }
  | { readonly _tag: 'MutationFailed'; readonly requestId: string; readonly error: RemoteError }
  | {
      readonly _tag: 'LiveReceived'
      readonly stream: string
      readonly event: LiveEvent
      readonly policy?: LivePolicy
      readonly now: number
    }
  | { readonly _tag: 'ConnectionMerged'; readonly connection: string; readonly page: Segment }
  | { readonly _tag: 'ConnectionInvalidated'; readonly connection: string }
  | { readonly _tag: 'ConnectionRefreshed'; readonly connection: string }
  | { readonly _tag: 'OptimisticAdded'; readonly layer: EntityLayer }
  | { readonly _tag: 'OptimisticRemoved'; readonly id: string }

const remoteMessageSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('ReadReceived'),
    requests: Schema.Array(ReadRequest),
    result: ReadBatchResult,
    now: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal('ReadFailed'),
    requests: Schema.Array(ReadRequest),
    error: remoteErrorSchema,
  }),
  Schema.Struct({ _tag: Schema.Literal('MutationStarted'), requestId: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal('MutationSucceeded'),
    requestId: Schema.String,
    entities: Schema.Array(NormalizedEntity),
  }),
  Schema.Struct({
    _tag: Schema.Literal('MutationFailed'),
    requestId: Schema.String,
    error: remoteErrorSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('LiveReceived'),
    stream: Schema.String,
    event: Schema.Unknown,
    policy: Schema.optional(Schema.Unknown),
    now: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal('ConnectionMerged'),
    connection: Schema.String,
    page: Schema.Unknown,
  }),
  Schema.Struct({ _tag: Schema.Literal('ConnectionInvalidated'), connection: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('ConnectionRefreshed'), connection: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('OptimisticAdded'), layer: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal('OptimisticRemoved'), id: Schema.String }),
]) as unknown as Schema.Schema<RemoteMessage>

const setConnectionStale = (
  connections: Readonly<Record<string, Connection>>,
  connection: string,
  stale: boolean,
): Readonly<Record<string, Connection>> => {
  const current = connections[connection] ?? emptyConnection
  return { ...connections, [connection]: { ...current, stale } }
}

const markGap = (model: RemoteModel, stream: string): RemoteModel =>
  model.gaps.has(stream) ? model : { ...model, gaps: new Set([...model.gaps, stream]) }

/**
 * The pure reducer all four producers share. A live event that arrives ahead of
 * its cursor is a gap: it is not applied, and the stream is recorded so the host
 * can resubscribe rather than silently miss facts.
 */
export const updateRemote = (model: RemoteModel, message: RemoteMessage): RemoteModel => {
  switch (message._tag) {
    case 'ReadReceived':
      return {
        ...model,
        entities: writeRead(model.entities, message.requests, message.result, message.now),
      }
    case 'ReadFailed':
      return model
    case 'MutationStarted':
      return { ...model, mutations: beginMutation(model.mutations, message.requestId) }
    case 'MutationSucceeded': {
      const reconciled = reconcileMutation(
        model.entities,
        model.mutations,
        message.requestId,
        message.entities,
      )
      // Settling the layer is remove-the-layer, so overlapping optimistic layers
      // rebase instead of needing inverse patches.
      return {
        ...model,
        entities: reconciled.store,
        mutations: reconciled.state,
        optimistic: removeLayer(model.optimistic, message.requestId),
      }
    }
    case 'MutationFailed':
      return {
        ...model,
        mutations: failMutation(model.mutations, message.requestId),
        optimistic: removeLayer(model.optimistic, message.requestId),
      }
    case 'LiveReceived': {
      const state = model.live[message.stream] ?? emptyLiveState
      if (message.event._tag === 'EntityPatched' || message.event._tag === 'EntityDeleted') {
        const applied = applyEntityEvent(state, model.entities, message.event, message.now)
        return applied.outcome === 'gap'
          ? markGap(model, message.stream)
          : {
              ...model,
              entities: applied.store,
              live: { ...model.live, [message.stream]: applied.state },
            }
      }
      const applied = applyConnectionEvent(state, model.optimistic, message.event, message.policy)
      return applied.outcome === 'gap'
        ? markGap(model, message.stream)
        : {
            ...model,
            optimistic: applied.optimistic,
            live: { ...model.live, [message.stream]: applied.state },
          }
    }
    case 'ConnectionMerged': {
      const current = model.connections[message.connection] ?? emptyConnection
      return {
        ...model,
        connections: { ...model.connections, [message.connection]: merge(current, message.page) },
      }
    }
    case 'ConnectionInvalidated':
      return {
        ...model,
        connections: setConnectionStale(model.connections, message.connection, true),
      }
    case 'ConnectionRefreshed':
      return {
        ...model,
        connections: setConnectionStale(model.connections, message.connection, false),
      }
    case 'OptimisticAdded':
      return { ...model, optimistic: addLayer(model.optimistic, message.layer) }
    case 'OptimisticRemoved':
      return { ...model, optimistic: removeLayer(model.optimistic, message.id) }
  }
}

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
}

declare const boundRemoteNames: unique symbol

export interface BoundRemote<AppModel, Store extends RemoteModel, Names extends string = string> {
  readonly definition: RemoteDescriptor
  readonly store: ModelRef<AppModel, Store>
  /** Phantom: the entity names this Remote definition registers. */
  readonly [boundRemoteNames]?: Names
}

const storeOf = <AppModel, Store extends RemoteModel, Names extends string>(
  bound: BoundRemote<AppModel, Store, Names>,
  model: AppModel,
): EntityStore => bound.store.get(model).entities

/**
 * The transport boundary. `foldkit-remote` never talks to a transport directly;
 * it depends on this Effect service, which a later phase wires to Effect RPC.
 */
export class RemoteClient extends Context.Service<
  RemoteClient,
  {
    readonly read: (
      batch: Schema.Schema.Type<typeof ReadBatch>,
    ) => Effect.Effect<Schema.Schema.Type<typeof ReadBatchResult>, RemoteReadError>
    readonly query: (
      request: Schema.Schema.Type<typeof QueryRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof QueryResult>, RemoteQueryError>
    readonly mutate: (
      request: Schema.Schema.Type<typeof MutationRequest>,
    ) => Effect.Effect<Schema.Schema.Type<typeof MutationResult>, RemoteMutationError>
    readonly live: (request: {
      readonly requirements: ReadonlyArray<Requirement>
      readonly after: LiveCursor
    }) => Stream.Stream<LiveEvent, RemoteLiveError>
  }
>()('foldkit-remote/RemoteClient') {}

interface WireRefPage {
  readonly refs: ReadonlyArray<string>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

const isWireRefPage = (value: unknown): value is WireRefPage => {
  if (value === null || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return (
    Array.isArray(page.refs) &&
    page.refs.every(ref => typeof ref === 'string') &&
    typeof page.hasNext === 'boolean' &&
    typeof page.hasPrevious === 'boolean'
  )
}

/** Appends (after) or prepends (before) an incoming page onto the stored one. */
const mergeWireRefPages = (
  current: WireRefPage,
  next: WireRefPage,
  direction: 'after' | 'before',
): WireRefPage => {
  const refs =
    direction === 'after'
      ? [...new Set([...current.refs, ...next.refs])]
      : [...new Set([...next.refs, ...current.refs])]
  return direction === 'after'
    ? { refs, hasNext: next.hasNext, hasPrevious: true }
    : { refs, hasNext: true, hasPrevious: next.hasPrevious }
}

/**
 * Writes a read result into the store, recording each field's applied window so
 * a later request with a different window refetches. A relation page requested
 * with a cursor is merged onto the page already stored, so "load more"
 * accumulates rather than replaces. Every read path should use this rather than
 * reducing `writeEntity` by hand.
 */
const writeRead = (
  store: EntityStore,
  requests: ReadonlyArray<Requirement>,
  result: Schema.Schema.Type<typeof ReadBatchResult>,
  now = 0,
): EntityStore => {
  const byEntity = new Map<
    string,
    { windows: Record<string, string>; merge: Map<string, 'after' | 'before'> }
  >()
  for (const request of requests) {
    const key = entityKey(request.entity, request.id)
    let entry = byEntity.get(key)
    if (entry === undefined) {
      entry = { windows: {}, merge: new Map() }
      byEntity.set(key, entry)
    }
    for (const [field, window] of Object.entries(request.windows ?? {})) {
      entry.windows[field] = windowKey(window)
      const direction =
        window.after !== undefined ? 'after' : window.before !== undefined ? 'before' : undefined
      if (direction !== undefined) entry.merge.set(field, direction)
    }
  }

  return result.entities.reduce((current, entity) => {
    const key = entityKey(entity.entity, entity.id)
    const entry = byEntity.get(key)
    let values = entity.values
    if (entry !== undefined && entry.merge.size > 0) {
      const previous = current[key]
      if (previous !== undefined) {
        const merged: Record<string, unknown> = { ...values }
        for (const [field, direction] of entry.merge) {
          const incoming = values[field]
          const existing = previous.values[field]
          if (isWireRefPage(incoming) && isWireRefPage(existing)) {
            merged[field] = mergeWireRefPages(existing, incoming, direction)
          }
        }
        values = merged
      }
    }
    return writeEntity(current, key, values, now, entry?.windows)
  }, store)
}

const remoteError = (error: { readonly _tag: string; readonly message: string }): RemoteError => ({
  _tag: error._tag,
  message: error.message,
})

/** A stable key for a live subscription's requirement set. */
const liveStreamKey = (requirements: readonly Requirement[]): string =>
  requirements
    .map(
      requirement =>
        `${entityKey(requirement.entity, requirement.id)}:${[...requirement.fields].sort().join(',')}`,
    )
    .sort()
    .join('|')

/**
 * `Remote.mutate` as a standalone effect, so `Remote.mutateInto` can reuse it
 * without the object literal referencing itself.
 */
const mutateRemote = Effect.fn('Remote.mutate')(function* <Name extends string, Input, Output>(
  mutation: MutationDescriptor<Name, Input, Output>,
  input: Input,
  requestId: string,
) {
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
  return { output, entities: result.entities }
})

export const Remote = {
  /**
   * Declares a Remote domain: the entities, queries, and mutations the
   * application can observe, plus the submodel (`Model`, `initial`, `Message`,
   * `update`, `rpc`) the app embeds and reduces.
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
  }),

  /**
   * A Projection node that reads a `RemoteData` value out of the store. The id
   * is supplied by the caller, usually from a Surface's params. The assembled
   * value is decoded against the Selection, so malformed server data surfaces
   * as `Failed` instead of being asserted into `Value`.
   */
  select:
    <AppModel, Store extends RemoteModel, Names extends string, Value, Name extends Names>(
      bound: BoundRemote<AppModel, Store, Names>,
      selection: Selection<Value, Name>,
    ) =>
    (id: string): Projection<AppModel, RemoteData<Value>> => ({
      Model: remoteDataSchema(selection.schema),
      dependencies: [],
      requirements: [
        {
          entity: selection.entity,
          id,
          fields: selection.fields,
          ...(selection.connections === undefined ? {} : { windows: selection.connections }),
        },
      ],
      read: (root: AppModel): RemoteData<Value> => {
        const store = storeOf(bound, root)
        const key = entityKey(selection.entity, id)
        if (isTombstone(store, key)) return { _tag: 'NotFound' }
        const values: Record<string, unknown> = {}
        for (const field of selection.fields) {
          const value = readField(store, key, field)
          if (Option.isNone(value)) return { _tag: 'Initial' }
          values[field] = value.value
        }
        const decoded = Schema.decodeUnknownResult(selection.schema)(values)
        return Result.isFailure(decoded)
          ? { _tag: 'Failed', error: { _tag: 'DecodeError', message: decoded.failure.message } }
          : { _tag: 'Ready', value: decoded.success }
      },
    }),

  /** The pure plan for a projection against a store. */
  planProjection: <Root, Value>(
    store: EntityStore,
    projection: Projection<Root, Value>,
    freshness?: PlanFreshness,
  ): ReadonlyArray<Requirement> => plan(store, projection.requirements, freshness),

  /** The pure plan for a projection against a Model, reading its remote store. */ observeProjection:
    <AppModel, Store extends RemoteModel, Value>(
      bound: BoundRemote<AppModel, Store>,
      model: AppModel,
      projection: Projection<AppModel, Value>,
      freshness?: PlanFreshness,
    ): ReadonlyArray<Requirement> =>
      plan(storeOf(bound, model), projection.requirements, freshness),

  /** The pure plan for a Surface's projection. */
  planSurface: <AppModel, Store extends RemoteModel, Model, Message, Params>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    surface: Surface<AppModel, Model, Message, Params>,
    params: Params,
    freshness?: PlanFreshness,
  ): ReadonlyArray<Requirement> =>
    plan(storeOf(bound, model), surface.projection(params).requirements, freshness),

  /**
   * Executes the plan against the `RemoteClient` and returns a new store. Used
   * for SSR route prefetch, hover prefetch, and tests. Never called during render.
   * `freshness` (milliseconds) refetches present fields older than that. The
   * caller reads the wall clock; the planner itself stays pure and time-injected.
   */
  prefetch: Effect.fn('Remote.prefetch')(function* <AppModel, Store extends RemoteModel, Value>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    projection: Projection<AppModel, Value>,
    options: { readonly freshness?: number } = {},
  ) {
    const store = storeOf(bound, model)
    const freshness: PlanFreshness | undefined =
      options.freshness === undefined
        ? undefined
        : { now: Date.now(), freshness: options.freshness }
    const missing = plan(store, projection.requirements, freshness)
    if (missing.length === 0) return store
    yield* Effect.annotateCurrentSpan('requirementCount', missing.length)
    const client = yield* RemoteClient
    const result = yield* client.read({ requests: missing })
    return writeRead(store, missing, result)
  }),

  /**
   * Writes a read result into the store, recording each field's applied window.
   * `requests` are the planned requirements the result answers.
   */
  writeRead,

  /**
   * Runs a mutation through `RemoteClient`, decoding its typed Output and
   * returning the result's normalized patches so the caller can reconcile them
   * through `Remote.update`'s `MutationSucceeded` (or `Remote.mutateInto`).
   */
  mutate: mutateRemote,

  /**
   * Runs a mutation and reconciles its patches into a `RemoteModel` in one step,
   * returning the new model alongside the typed Output. The model-level form of
   * `MutationStarted` → `RemoteClient.mutate` → `MutationSucceeded`.
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
  ) {
    const started = updateRemote(bound.store.get(model), { _tag: 'MutationStarted', requestId })
    const outcome = yield* mutateRemote(mutation, input, requestId)
    const settled = updateRemote(started, {
      _tag: 'MutationSucceeded',
      requestId,
      entities: outcome.entities,
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
   * with the domain's `update`.
   */
  observe: <
    AppModel,
    Store extends RemoteModel,
    Names extends string,
    Model,
    SurfaceMessage,
    Params,
    Message,
  >(
    bound: BoundRemote<AppModel, Store, Names>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (message: RemoteMessage) => Message,
  ): EntryWithoutKeepAlive<
    AppModel,
    Message,
    { readonly requirements: ReadonlyArray<Requirement> },
    RemoteClient
  > => ({
    dependenciesSchema: Schema.Struct({
      requirements: Schema.Array(ReadRequest),
    }),
    modelToDependencies: model => ({
      requirements: plan(storeOf(bound, model), surface.projection(params).requirements),
    }),
    dependenciesToStream: ({ requirements }) =>
      requirements.length === 0
        ? Stream.empty
        : Stream.fromEffect(
            Effect.gen(function* () {
              const client = yield* RemoteClient
              const now = Date.now()
              const result = yield* Effect.result(client.read({ requests: requirements }))
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
                    now,
                  })
            }),
          ),
  }),

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
    Message,
  >(
    bound: BoundRemote<AppModel, Store, Names>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (message: RemoteMessage) => Message,
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
                now: Date.now(),
              }),
            ),
            Stream.catchIf(
              (_error): _error is RemoteLiveError => true,
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
