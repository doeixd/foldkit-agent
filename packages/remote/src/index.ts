/**
 * `foldkit-remote` — normalized application-facing server state.
 *
 * Phase 3 is the **pure core**: entity identity, selections, and `RemoteData`.
 * The store, planner, and wire land in later phases. Nothing here performs I/O.
 */
import { Context, Effect, Option, Result, Schema, SchemaGetter, Stream } from 'effect'
import type { EntryWithoutKeepAlive } from 'foldkit/subscription'
import type { ModelRef, Projection, Requirement, Surface } from 'foldkit-surface'
import { entityKey, isTombstone, readField, writeEntity, type EntityStore } from './store.js'
import { plan, windowKey } from './plan.js'
import {
  MutationRequest,
  MutationResult,
  QueryRequest,
  QueryResult,
  ReadBatch,
  ReadBatchResult,
  ReadRequest,
  RemoteLiveError,
  RemoteMutationError,
  RemoteQueryError,
  RemoteReadError,
} from './wire.js'
import type { LiveCursor, LiveEvent } from './live.js'
import type { QueryWindow } from './query.js'

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

export interface Selection<Value> {
  readonly entity: string
  readonly fields: readonly string[]
  readonly schema: Schema.Schema<Value>
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
  ): Selection<SelectionValue<F, Sel>> => {
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
      schema: Schema.Struct(picked) as unknown as Schema.Schema<SelectionValue<F, Sel>>,
      ...(Object.keys(connections).length === 0 ? {} : { connections }),
    }
  },

  /** A paginated relation: one page of refs to `entity`, with a window. */
  connection: <Name extends string, F extends Schema.Struct.Fields>(
    entity: EntityDescriptor<Name, F>,
    window: QueryWindow,
  ): Selection<RefPage<Name, F>> => ({
    entity: entity.name,
    fields: [],
    schema: Entity.refPage(entity) as unknown as Schema.Schema<RefPage<Name, F>>,
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

/** The Remote scope's slot in the application Model. */
export interface RemoteModel {
  readonly entities: EntityStore
  readonly connections: Readonly<Record<string, unknown>>
  readonly requests: Readonly<Record<string, unknown>>
  readonly mutations: Readonly<Record<string, unknown>>
}

/**
 * `EntityStore` is a runtime value (Sets and all), not a wire shape, and the
 * store is built in memory rather than decoded. This schema carries the layout
 * for `RemoteModel` without pretending to validate the entries.
 */
const entityStoreSchema = Schema.Unknown as unknown as Schema.Schema<EntityStore>

const remoteModelSchema = (): Schema.Struct<{
  readonly entities: Schema.Schema<EntityStore>
  readonly connections: Schema.Schema<Readonly<Record<string, unknown>>>
  readonly requests: Schema.Schema<Readonly<Record<string, unknown>>>
  readonly mutations: Schema.Schema<Readonly<Record<string, unknown>>>
}> =>
  Schema.Struct({
    entities: entityStoreSchema,
    connections: Schema.Record(Schema.String, Schema.Unknown),
    requests: Schema.Record(Schema.String, Schema.Unknown),
    mutations: Schema.Record(Schema.String, Schema.Unknown),
  })

export interface RemoteDescriptor<Model extends Schema.Struct<Schema.Struct.Fields>> {
  readonly entities: readonly unknown[]
  readonly Model: Model
}

export interface BoundRemote<AppModel, Store extends RemoteModel> {
  readonly store: ModelRef<AppModel, Store>
}

const storeOf = <AppModel, Store extends RemoteModel>(
  bound: BoundRemote<AppModel, Store>,
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

/**
 * Writes a read result into the store, recording each field's applied window so
 * a later request with a different window refetches. Every read path should use
 * this rather than reducing `writeEntity` by hand.
 */
const writeRead = (
  store: EntityStore,
  requests: ReadonlyArray<Requirement>,
  result: Schema.Schema.Type<typeof ReadBatchResult>,
  now = 0,
): EntityStore => {
  const windowsByEntity = new Map<string, Record<string, string>>()
  for (const request of requests) {
    if (request.windows === undefined) continue
    const key = entityKey(request.entity, request.id)
    const windows = windowsByEntity.get(key) ?? {}
    for (const [field, window] of Object.entries(request.windows)) {
      windows[field] = windowKey(window)
    }
    windowsByEntity.set(key, windows)
  }
  return result.entities.reduce((current, entity) => {
    const key = entityKey(entity.entity, entity.id)
    return writeEntity(current, key, entity.values, now, windowsByEntity.get(key))
  }, store)
}

export const Remote = {
  make: <const Entities extends readonly EntityDescriptor<any, any>[]>(config: {
    readonly entities: Entities
    readonly queries?: readonly unknown[]
    readonly mutations?: readonly unknown[]
  }): RemoteDescriptor<ReturnType<typeof remoteModelSchema>> => ({
    entities: config.entities,
    Model: remoteModelSchema(),
  }),

  /** Binds a Remote scope to its store's location in the application Model. */
  at: <AppModel, Store extends RemoteModel>(
    _definition: RemoteDescriptor<any>,
    store: ModelRef<AppModel, Store>,
  ): BoundRemote<AppModel, Store> => ({ store }),

  /**
   * A Projection node that reads a `RemoteData` value out of the store. The id
   * is supplied by the caller, usually from a Surface's params. The assembled
   * value is decoded against the Selection, so malformed server data surfaces
   * as `Failed` instead of being asserted into `Value`.
   */
  select:
    <AppModel, Store extends RemoteModel, Value>(
      bound: BoundRemote<AppModel, Store>,
      selection: Selection<Value>,
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
        const decoded = Schema.decodeUnknownResult(
          selection.schema as unknown as Schema.ConstraintDecoder<Value>,
        )(values)
        return Result.isFailure(decoded)
          ? { _tag: 'Failed', error: { _tag: 'DecodeError', message: decoded.failure.message } }
          : { _tag: 'Ready', value: decoded.success }
      },
    }),

  /** The remote requirements a Projection contributes. */
  requirements: <Root, Value>(projection: Projection<Root, Value>): readonly Requirement[] =>
    projection.requirements,

  /** The pure plan for a projection against a store. */
  planProjection: <Root, Value>(
    store: EntityStore,
    projection: Projection<Root, Value>,
  ): ReadonlyArray<Requirement> => plan(store, projection.requirements),

  /** The pure plan for a projection against a Model, reading its remote store. */ observeProjection:
    <AppModel, Store extends RemoteModel, Value>(
      bound: BoundRemote<AppModel, Store>,
      model: AppModel,
      projection: Projection<AppModel, Value>,
    ): ReadonlyArray<Requirement> => plan(storeOf(bound, model), projection.requirements),

  /** The pure plan for a Surface's projection. */
  planSurface: <AppModel, Store extends RemoteModel, Model, Message, Params>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    surface: Surface<AppModel, Model, Message, Params>,
    params: Params,
  ): ReadonlyArray<Requirement> =>
    plan(storeOf(bound, model), surface.projection(params).requirements),

  /**
   * Executes the plan against the `RemoteClient` and returns a new store. Used
   * for SSR route prefetch, hover prefetch, and tests. Never called during render.
   */
  prefetch: Effect.fn('Remote.prefetch')(function* <AppModel, Store extends RemoteModel, Value>(
    bound: BoundRemote<AppModel, Store>,
    model: AppModel,
    projection: Projection<AppModel, Value>,
  ) {
    const store = storeOf(bound, model)
    const missing = plan(store, projection.requirements)
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

  /** Runs a mutation through `RemoteClient`, decoding its typed Output. */
  mutate: Effect.fn('Remote.mutate')(function* <Name extends string, Input, Output>(
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
    return yield* Schema.decodeUnknownEffect(mutation.Output)(result.output).pipe(
      Effect.catchTag('SchemaError', error =>
        Effect.fail(new RemoteMutationError({ message: error.message })),
      ),
    )
  }),

  /**
   * A Foldkit Subscription entry that plans a Surface's missing fields from the
   * Model and fetches them through `RemoteClient`, emitting a Message per batch.
   * Pass the returned entry into the application's `Subscription.make` record.
   */
  observe: <AppModel, Store extends RemoteModel, Model, SurfaceMessage, Params, Message>(
    bound: BoundRemote<AppModel, Store>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    toMessage: (
      result: Schema.Schema.Type<typeof ReadBatchResult>,
      requests: ReadonlyArray<Requirement>,
    ) => Message,
    onError: (error: RemoteReadError) => Message,
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
            Effect.fn('Remote.observe.read')(function* () {
              const client = yield* RemoteClient
              return yield* client.read({ requests: requirements })
            })(),
          ).pipe(
            Stream.map(result => toMessage(result, requirements)),
            Stream.catchIf(
              (_error): _error is RemoteReadError => true,
              error => Stream.succeed(onError(error)),
            ),
          ),
  }),

  /**
   * A Foldkit Subscription entry that consumes the live stream for a Surface's
   * requirements. On any stream failure (including `ResumeUnavailable`) it emits
   * `onResumeUnavailable`, so the app invalidates and refetches rather than
   * silently missing events.
   */
  live: <AppModel, Store extends RemoteModel, Model, SurfaceMessage, Params, Message>(
    bound: BoundRemote<AppModel, Store>,
    surface: Surface<AppModel, Model, SurfaceMessage, Params>,
    params: Params,
    options: {
      readonly cursor: (model: AppModel) => LiveCursor
    },
    toMessage: (event: LiveEvent) => Message,
    onResumeUnavailable: (error: RemoteLiveError) => Message,
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
    modelToDependencies: model => ({
      requirements: surface.projection(params).requirements,
      cursor: options.cursor(model),
    }),
    dependenciesToStream: ({ requirements, cursor }) =>
      requirements.length === 0
        ? Stream.empty
        : Stream.unwrap(
            Effect.fn('Remote.live.subscribe')(function* () {
              const client = yield* RemoteClient
              return client.live({ requirements, after: cursor })
            })(),
          ).pipe(
            Stream.map(toMessage),
            Stream.catchIf(
              (_error): _error is RemoteLiveError => true,
              error => Stream.succeed(onResumeUnavailable(error)),
            ),
          ),
  }),
}
