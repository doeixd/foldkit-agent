/**
 * `foldkit-remote` — normalized application-facing server state.
 *
 * The pure core (entities, selections, the store, the planner, connections,
 * live classification, optimistic layers) performs no I/O. The `Remote.*`
 * helpers that read or mutate go through the `RemoteClient` Effect service.
 */
import { Context, Effect, Layer, Option, Result, Schema, SchemaGetter, Stream } from 'effect'
import type { Duration } from 'effect'
import type { EntryWithoutKeepAlive } from 'foldkit/subscription'
import {
  Requirement,
  type Contract,
  type ModelRef,
  type Projection,
  type RelationRequirement,
  type Surface,
} from 'foldkit-surface'
import { emptyConnection, merge, type Connection, type Edge, type Segment } from './connection.js'
import {
  Optimistic,
  emptyOptimistic,
  pruneOverlays,
  settleFailure,
  settleSuccess,
  visibleItems,
  type ConnectionChange,
  type OptimisticOperation,
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
  isFieldStale,
  isTombstone,
  markStale,
  readField,
  writeEntity,
  type EntityEntry,
  type EntityStore,
} from './store.js'
import { plan, windowKey, type PlanOptions } from './plan.js'
import { RemotePolicy } from './policy.js'
import { RelationAnnotation, isRefPage, refsIn, relationShape } from './relation.js'
import { coalesceReads, type CoalesceOptions } from './coalesce.js'
import { gc, type RetentionRoots } from './retain.js'
import {
  MutationRequest,
  MutationResult,
  NormalizedEntity,
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  ReadRequest,
  REMOTE_PROTOCOL_VERSION,
  type ConnectionChangeSchema,
  RemoteLiveError,
  RemoteMutationError,
  RemoteProtocolError,
  RemoteQueryError,
  RemoteReadError,
  RemoteRpc,
  type LiveChange,
  type LiveRequirement,
} from './wire.js'
import type { LivePolicy, QueryDescriptor, QueryRef, QueryWindow } from './query.js'

type AnySchema = Schema.Schema<unknown>

export * from './store.js'
export * from './plan.js'
export * from './policy.js'
export * from './relation.js'
export * from './coalesce.js'
export * from './retain.js'
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
  // A method, not a property: method signatures are bivariant, so a concrete
  // descriptor stays assignable to `EntityDescriptor<any, any>` (which appears
  // in every heterogeneous collection, e.g. `Remote.make`'s entities).
  ref(id: Schema.Schema.Type<F['id']>): EntityRef<Name, F>
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
  Schema.Struct({ entity: Schema.String, id: Schema.String })
    .pipe(
      Schema.encodeTo(Schema.String, {
        decode: SchemaGetter.transform(decodeRef),
        encode: SchemaGetter.transform(encodeRef),
      }),
    )
    .annotate({ [RelationAnnotation]: 'one' }) as unknown as Schema.Codec<
    EntityRef<Name, F>,
    string
  >

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
  }).annotate({ [RelationAnnotation]: 'page' }) as unknown as Schema.Codec<
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

/** One page of a paginated relation with each target assembled through a nested selection. */
export interface Page<Item> {
  readonly items: ReadonlyArray<Item>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

/**
 * The fields a projection reads of one entity, plus the slice it reads of each
 * relation's target. `Shape` tells a parent selection whether this one is a
 * paginated relation (`connection`) or a plain entity slice (`entity`).
 */
export interface Selection<
  Value,
  Name extends string = string,
  Shape extends 'entity' | 'connection' = 'entity' | 'connection',
> {
  readonly entity: Name
  readonly fields: readonly string[]
  /** A pure codec: entity fields carry no decoding or encoding services. */
  readonly schema: Schema.Codec<Value, unknown, never, never>
  /** Pagination windows for nested relation fields, keyed by field name. */
  readonly connections?: Readonly<Record<string, QueryWindow>> | undefined
  /** The slice required of each nested relation's target, keyed by field name. */
  readonly relations?: Readonly<Record<string, RelationRequirement>> | undefined
  /** Present when this selection is itself a paginated relation. */
  readonly window?: QueryWindow | undefined
  /** Phantom: see `Shape`. */
  readonly shape?: Shape
}

type SelectionOf<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: true | Selection<unknown, string, 'entity' | 'connection'>
}

/** A nested selection's value takes the shape of the field it selects through. */
type NestedValue<Field, Sel> =
  Sel extends Selection<infer V, string, 'connection'>
    ? V
    : Sel extends Selection<infer V, string, 'entity'>
      ? Field extends ReadonlyArray<EntityRef<any, any>>
        ? ReadonlyArray<V>
        : Field extends RefPage<any, any>
          ? Page<V>
          : null extends Field
            ? V | null
            : V
      : never

type SelectionValue<F extends Schema.Struct.Fields, Sel> = {
  readonly [K in keyof Sel & keyof F]: Sel[K] extends true
    ? Schema.Schema.Type<F[K]>
    : NestedValue<Schema.Schema.Type<F[K]>, Sel[K]>
}

const pageSchema = (item: AnySchema): AnySchema =>
  Schema.Struct({
    items: Schema.Array(item),
    hasNext: Schema.Boolean,
    hasPrevious: Schema.Boolean,
  }) as unknown as AnySchema

/** The requirement a nested selection contributes for its relation's target. */
const relationOf = (selection: Selection<unknown>): RelationRequirement => ({
  entity: selection.entity,
  fields: selection.fields,
  ...(selection.connections === undefined ? {} : { windows: selection.connections }),
  ...(selection.relations === undefined ? {} : { relations: selection.relations }),
})

export const Selection = {
  /**
   * The fields to read of `entity`. A nested `Selection` on a relation field
   * reads through the ref (or refs, or page of refs) the field holds into the
   * target's fields; a scalar field cannot take one.
   */
  make: <Name extends string, F extends Schema.Struct.Fields, const Sel extends SelectionOf<F>>(
    entity: EntityDescriptor<Name, F>,
    selection: Sel,
  ): Selection<SelectionValue<F, Sel>, Name, 'entity'> => {
    const picked: Record<string, AnySchema> = {}
    const connections: Record<string, QueryWindow> = {}
    const relations: Record<string, RelationRequirement> = {}
    for (const key of Object.keys(selection)) {
      const choice = (selection as Record<string, unknown>)[key]
      if (choice === true) {
        picked[key] = entity.fields[key] as AnySchema
        continue
      }
      const nested = choice as Selection<unknown>
      if (nested.window !== undefined) {
        // A connection: the nested selection already carries its page codec.
        connections[key] = nested.window
        picked[key] = nested.schema as AnySchema
        if (nested.fields.length > 0) relations[key] = relationOf(nested)
        continue
      }
      const shape = relationShape(entity.fields[key] as Schema.Top)
      if (shape === undefined) {
        throw new Error(
          `Selection.make: "${key}" on "${entity.name}" is not a relation field, so it cannot take a nested selection`,
        )
      }
      const item = nested.schema as AnySchema
      picked[key] =
        shape.kind === 'many'
          ? (Schema.Array(item) as unknown as AnySchema)
          : shape.kind === 'page'
            ? pageSchema(item)
            : shape.nullable
              ? (Schema.NullOr(item) as unknown as AnySchema)
              : item
      relations[key] = relationOf(nested)
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
      ...(Object.keys(relations).length === 0 ? {} : { relations }),
    }
  },

  /**
   * A paginated relation: one page of refs to `entity` with a window, or, with
   * a nested selection, one page of targets assembled through it.
   */
  connection: (<Name extends string, F extends Schema.Struct.Fields, Item = never>(
    entity: EntityDescriptor<Name, F>,
    window: QueryWindow,
    selection?: Selection<Item, Name, 'entity'>,
  ): Selection<RefPage<Name, F> | Page<Item>, Name, 'connection'> => ({
    entity: entity.name,
    fields: selection?.fields ?? [],
    schema: (selection === undefined
      ? Entity.refPage(entity)
      : pageSchema(selection.schema as AnySchema)) as unknown as Schema.Codec<
      RefPage<Name, F> | Page<Item>,
      unknown,
      never,
      never
    >,
    window,
    ...(selection?.connections === undefined ? {} : { connections: selection.connections }),
    ...(selection?.relations === undefined ? {} : { relations: selection.relations }),
  })) as {
    <Name extends string, F extends Schema.Struct.Fields>(
      entity: EntityDescriptor<Name, F>,
      window: QueryWindow,
    ): Selection<RefPage<Name, F>, Name, 'connection'>
    <Name extends string, F extends Schema.Struct.Fields, Item>(
      entity: EntityDescriptor<Name, F>,
      window: QueryWindow,
      selection: Selection<Item, Name, 'entity'>,
    ): Selection<Page<Item>, Name, 'connection'>
  },
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
 * The normalized cache as a Foldkit Submodel. `Remote.make` returns a schema and
 * an `update` for this shape; `Remote.update` reconciles every producer.
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

/** The submodel's Messages; each reduces to `RemoteModel` through `Remote.update`. */
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
  /** A refetch of present fields began; they read as `Refreshing` until it lands. */
  | { readonly _tag: 'RefreshStarted'; readonly requests: readonly Requirement[] }
  /** The active Surfaces' roots changed; everything they do not reach is collected. */
  | { readonly _tag: 'RetentionChanged'; readonly roots: RetentionRoots }
  /** A mutation began; its optimistic operations show until it settles. */
  | {
      readonly _tag: 'MutationStarted'
      readonly requestId: string
      readonly optimistic?: ReadonlyArray<OptimisticOperation> | undefined
    }
  | {
      readonly _tag: 'MutationSucceeded'
      readonly requestId: string
      readonly entities: readonly NormalizedPatch[]
      /** Connection changes the server confirmed; they replace the request's own. */
      readonly connections?: ReadonlyArray<ConnectionChange> | undefined
    }
  | { readonly _tag: 'MutationFailed'; readonly requestId: string; readonly error: RemoteError }
  | {
      readonly _tag: 'LiveReceived'
      readonly stream: string
      readonly event: LiveEvent
      readonly policy?: LivePolicy
      readonly now: number
    }
  | { readonly _tag: 'GapCleared'; readonly stream: string }
  | { readonly _tag: 'ConnectionMerged'; readonly connection: string; readonly page: Segment }
  | { readonly _tag: 'ConnectionInvalidated'; readonly connection: string }
  | { readonly _tag: 'ConnectionRefreshed'; readonly connection: string }

const retentionRootsSchema = Schema.Struct({
  requirements: Schema.Array(ReadRequest),
  connections: Schema.Array(Schema.String),
})

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
  Schema.Struct({ _tag: Schema.Literal('RefreshStarted'), requests: Schema.Array(ReadRequest) }),
  Schema.Struct({ _tag: Schema.Literal('RetentionChanged'), roots: retentionRootsSchema }),
  Schema.Struct({
    _tag: Schema.Literal('MutationStarted'),
    requestId: Schema.String,
    optimistic: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({
    _tag: Schema.Literal('MutationSucceeded'),
    requestId: Schema.String,
    entities: Schema.Array(NormalizedEntity),
    connections: Schema.optional(Schema.Array(Schema.Unknown)),
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
  Schema.Struct({ _tag: Schema.Literal('GapCleared'), stream: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal('ConnectionMerged'),
    connection: Schema.String,
    page: Schema.Unknown,
  }),
  Schema.Struct({ _tag: Schema.Literal('ConnectionInvalidated'), connection: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('ConnectionRefreshed'), connection: Schema.String }),
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

const clearGap = (model: RemoteModel, stream: string): RemoteModel =>
  model.gaps.has(stream)
    ? { ...model, gaps: new Set([...model.gaps].filter(entry => entry !== stream)) }
    : model

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
    case 'RetentionChanged':
      return { ...model, ...gc(model, message.roots) }
    case 'RefreshStarted':
      return {
        ...model,
        entities: message.requests.reduce(
          (store, request) =>
            markStale(store, entityKey(request.entity, request.id), request.fields),
          model.entities,
        ),
      }
    case 'MutationStarted':
      return {
        ...model,
        mutations: beginMutation(model.mutations, message.requestId),
        optimistic: Optimistic.begin(model.optimistic, message.requestId, message.optimistic ?? []),
      }
    case 'MutationSucceeded': {
      // Settling is release-the-layer-and-overlays, so overlapping optimistic
      // layers rebase instead of needing inverse patches.
      const settled = settleSuccess(
        model.entities,
        model.optimistic,
        model.mutations,
        message.requestId,
        message.entities,
        message.connections ?? [],
      )
      return {
        ...model,
        entities: settled.store,
        mutations: settled.state,
        optimistic: settled.optimistic,
      }
    }
    case 'MutationFailed':
      return {
        ...model,
        mutations: failMutation(model.mutations, message.requestId),
        optimistic: settleFailure(model.optimistic, message.requestId),
      }
    case 'LiveReceived': {
      const state = model.live[message.stream] ?? emptyLiveState
      if (message.event._tag === 'EntityPatched' || message.event._tag === 'EntityDeleted') {
        const applied = applyEntityEvent(state, model.entities, message.event, message.now)
        return applied.outcome === 'gap'
          ? markGap(model, message.stream)
          : clearGap(
              {
                ...model,
                entities: applied.store,
                live: { ...model.live, [message.stream]: applied.state },
              },
              message.stream,
            )
      }
      const applied = applyConnectionEvent(state, model.optimistic, message.event, message.policy)
      return applied.outcome === 'gap'
        ? markGap(model, message.stream)
        : clearGap(
            {
              ...model,
              optimistic: applied.optimistic,
              live: { ...model.live, [message.stream]: applied.state },
            },
            message.stream,
          )
    }
    case 'GapCleared':
      return clearGap(model, message.stream)
    case 'ConnectionMerged': {
      const current = model.connections[message.connection] ?? emptyConnection
      return {
        ...model,
        connections: { ...model.connections, [message.connection]: merge(current, message.page) },
        optimistic: pruneOverlays(
          model.optimistic,
          message.connection,
          new Set(message.page.edges.map(edge => edge.key)),
          model.mutations.pending,
        ),
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

export interface RetainOptions {
  /** Query connection identities (`QueryRef.identity`) the application shows. */
  readonly connections?: ReadonlyArray<string> | undefined
  /** How long the roots must be stable before collecting; default none. */
  readonly grace?: Duration.Input | undefined
}

const coalescedLayer = (
  layer: Layer.Layer<RemoteClient>,
  options: CoalesceOptions = {},
): Layer.Layer<RemoteClient> =>
  Layer.effect(
    RemoteClient,
    Effect.gen(function* () {
      const client = yield* RemoteClient
      const read = yield* coalesceReads(client.read, options)
      return { ...client, read }
    }),
  ).pipe(Layer.provide(layer))

/** How `Remote.observe` and `Remote.prefetch` treat fields the store already holds. */
export interface ObserveOptions {
  /** Default `RemotePolicy.cacheFirst`. */
  readonly policy?: RemotePolicy | undefined
  /** The clock a refreshing policy reads; default `Date.now`. */
  readonly now?: (() => number) | undefined
}

interface WireRefPage {
  readonly refs: ReadonlyArray<string>
  readonly hasNext: boolean
  readonly hasPrevious: boolean
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
          if (isRefPage(incoming) && isRefPage(existing)) {
            merged[field] = mergeWireRefPages(existing, incoming, direction)
          }
        }
        values = merged
      }
    }
    return writeEntity(current, key, values, now, entry?.windows)
  }, store)
}

interface Assembled {
  readonly values: unknown
  readonly refreshing: boolean
}

/**
 * Reads an entity's selected fields out of the store, following each nested
 * relation into its targets. `undefined` means some field, at any depth, is
 * not present yet. A tombstoned target reads as `null` (or is dropped from a
 * list), so the Selection's codec decides whether that is a failure.
 */
const assemble = (
  store: EntityStore,
  key: string,
  requirement: RelationRequirement,
): Assembled | undefined => {
  const values: Record<string, unknown> = {}
  let refreshing = false
  for (const field of requirement.fields) {
    const value = readField(store, key, field)
    if (Option.isNone(value)) return undefined
    refreshing ||= isFieldStale(store, key, field)
    const relation = requirement.relations?.[field]
    if (relation === undefined) {
      values[field] = value.value
      continue
    }
    const nested = assembleRelation(store, value.value, relation)
    if (nested === undefined) return undefined
    values[field] = nested.values
    refreshing ||= nested.refreshing
  }
  return { values, refreshing }
}

const assembleTarget = (
  store: EntityStore,
  ref: { readonly entity: string; readonly id: string },
  relation: RelationRequirement,
): Assembled | 'absent' | undefined => {
  const key = entityKey(ref.entity, ref.id)
  return isTombstone(store, key) ? 'absent' : assemble(store, key, relation)
}

/** Assembles the targets a relation value refers to, in the value's own shape. */
const assembleRelation = (
  store: EntityStore,
  value: unknown,
  relation: RelationRequirement,
): Assembled | undefined => {
  if (value === null || value === undefined) return { values: null, refreshing: false }
  const refs = refsIn(value)
  const targets: unknown[] = []
  let refreshing = false
  for (const ref of refs) {
    const target = assembleTarget(store, ref, relation)
    if (target === undefined) return undefined
    if (target === 'absent') continue
    targets.push(target.values)
    refreshing ||= target.refreshing
  }
  if (typeof value === 'string') {
    return { values: targets.length === 0 ? null : targets[0], refreshing }
  }
  if (isRefPage(value)) {
    return {
      values: { items: targets, hasNext: value.hasNext, hasPrevious: value.hasPrevious },
      refreshing,
    }
  }
  return { values: targets, refreshing }
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

/** A serializable summary of a RemoteModel for DevTools and diagnostics. */
export interface RemoteInspection {
  readonly entities: ReadonlyArray<{
    readonly key: string
    readonly present: ReadonlyArray<string>
    readonly stale: ReadonlyArray<string>
    readonly tombstone: boolean
    readonly updatedAt: number
    readonly windows: Readonly<Record<string, string>>
  }>
  readonly connections: ReadonlyArray<string>
  readonly live: ReadonlyArray<string>
  readonly gaps: ReadonlyArray<string>
  readonly mutations: {
    readonly pending: ReadonlyArray<string>
    readonly failed: ReadonlyArray<string>
    readonly applied: number
  }
}

const inspectEntry = (key: string, entry: EntityEntry): RemoteInspection['entities'][number] => ({
  key,
  present: [...entry.present],
  stale: [...entry.stale],
  tombstone: entry.tombstone,
  updatedAt: entry.updatedAt,
  windows: { ...entry.windows },
})

/** A pure, serializable view of the whole cache. */
export const inspectRemote = (model: RemoteModel): RemoteInspection => ({
  entities: Object.entries(model.entities).map(([key, entry]) => inspectEntry(key, entry)),
  connections: Object.keys(model.connections),
  live: Object.keys(model.live),
  gaps: [...model.gaps],
  mutations: {
    pending: [...model.mutations.pending],
    failed: [...model.mutations.failed],
    applied: model.mutations.applied.size,
  },
})

/** A pure, serializable view of one entity, or `undefined` if unknown. */
export const inspectEntity = (
  model: RemoteModel,
  key: string,
): RemoteInspection['entities'][number] | undefined => {
  const entry = model.entities[key]
  return entry === undefined ? undefined : inspectEntry(key, entry)
}

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
  return {
    output,
    entities: result.entities,
    connections: (result.connections ?? []).map(connectionChangeOf),
  }
})

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
      selection: Selection<Value, Name>,
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

  /** The pure plan for a projection against a store. */
  planProjection: <Root, Value>(
    store: EntityStore,
    projection: Projection<Root, Value>,
    options?: PlanOptions,
  ): ReadonlyArray<Requirement> => plan(store, projection.requirements, options),

  /** The pure plan for a projection against a Model, reading its remote store. */ observeProjection:
    <AppModel, Store extends RemoteModel, Value>(
      bound: BoundRemote<AppModel, Store>,
      model: AppModel,
      projection: Projection<AppModel, Value>,
      options?: PlanOptions,
    ): ReadonlyArray<Requirement> => plan(storeOf(bound, model), projection.requirements, options),

  /** The pure plan for a Surface's projection. */
  planSurface: <AppModel, Store extends RemoteModel, Model, Message, Params>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    surface: Surface<AppModel, Model, Message, Params>,
    params: Params,
    options?: PlanOptions,
  ): ReadonlyArray<Requirement> =>
    plan(storeOf(bound, model), surface.projection(params).requirements, options),

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
    const missing = plan(store, projection.requirements, RemotePolicy.toPlan(policy, now()))
    if (missing.length === 0) return store
    yield* Effect.annotateCurrentSpan('requirementCount', missing.length)
    const client = yield* RemoteClient
    const result = yield* client.read({ version: REMOTE_PROTOCOL_VERSION, requests: missing })
    return writeRead(store, missing, result)
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
  clientLayer: (
    client: RemoteRpcClient,
    options: CoalesceOptions = {},
  ): Layer.Layer<RemoteClient> =>
    coalescedLayer(
      Layer.succeed(RemoteClient, {
        read: batch => client.FoldkitRemoteRead(batch),
        query: request => client.FoldkitRemoteQuery(request),
        mutate: request => client.FoldkitRemoteMutate(request),
        live: ({ requirements, after }) =>
          client
            .FoldkitRemoteLive({ version: REMOTE_PROTOCOL_VERSION, requirements, after })
            .pipe(Stream.map(liveEventOf)),
      }),
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
  retain: <AppModel, Store extends RemoteModel, Message>(
    bound: BoundRemote<AppModel, Store>,
    projections: ReadonlyArray<{ readonly requirements: readonly Requirement[] }>,
    toMessage: (message: RemoteMessage) => Message,
    options: RetainOptions = {},
  ): EntryWithoutKeepAlive<AppModel, Message, RetentionRoots, never> => {
    const roots: RetentionRoots = {
      requirements: Requirement.merge(projections.flatMap(projection => projection.requirements)),
      connections: [...new Set(options.connections ?? [])].sort(),
    }
    void bound
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
  visibleItems: (model: RemoteModel, connection: string): ReadonlyArray<Edge> =>
    visibleItems(
      model.connections[connection] ?? emptyConnection,
      connection,
      model.optimistic.overlays,
      model.entities,
    ),

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
    options: { readonly optimistic?: ReadonlyArray<OptimisticOperation> | undefined } = {},
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
    Message,
  >(
    bound: BoundRemote<AppModel, Store, Names>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (message: RemoteMessage) => Message,
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
          : RemotePolicy.refreshes(policy)
            ? Stream.concat(
                Stream.succeed(toMessage({ _tag: 'RefreshStarted', requests: requirements })),
                Stream.fromEffect(read(requirements)),
              )
            : Stream.fromEffect(read(requirements)),
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
