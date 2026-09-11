/**
 * `foldkit-remote` — normalized application-facing server state.
 *
 * Phase 3 is the **pure core**: entity identity, selections, and `RemoteData`.
 * The store, planner, and wire land in later phases. Nothing here performs I/O.
 */
import { Option, Schema, SchemaGetter } from 'effect'
import type { ModelRef, Projection, Requirement } from 'foldkit-surface'
import { entityKey, isTombstone, readField, type EntityStore } from './store.js'

type AnySchema = Schema.Schema<unknown>

export * from './store.js'
export * from './plan.js'
export * from './connection.js'
export * from './query.js'

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

  patch: <Name extends string, F extends Schema.Struct.Fields>(
    _ref: EntityRef<Name, F>,
    patch: Partial<Schema.Struct.Type<F>>,
  ): Partial<Schema.Struct.Type<F>> => patch,
}

// ===========================================================================
// Selection
// ===========================================================================

export interface Selection<Value> {
  readonly entity: string
  readonly fields: readonly string[]
  readonly schema: Schema.Schema<Value>
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
    for (const key of Object.keys(selection)) {
      const choice = (selection as Record<string, unknown>)[key]
      picked[key] = (
        choice === true ? entity.fields[key] : (choice as Selection<unknown>).schema
      ) as AnySchema
    }
    return {
      entity: entity.name,
      fields: Object.keys(selection),
      schema: Schema.Struct(picked) as unknown as Schema.Schema<SelectionValue<F, Sel>>,
    }
  },
}

// ===========================================================================
// RemoteData and the Remote scope
// ===========================================================================

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

const remoteModelSchema = (): Schema.Struct<{
  readonly entities: Schema.Schema<Readonly<Record<string, unknown>>>
  readonly connections: Schema.Schema<Readonly<Record<string, unknown>>>
  readonly requests: Schema.Schema<Readonly<Record<string, unknown>>>
  readonly mutations: Schema.Schema<Readonly<Record<string, unknown>>>
}> =>
  Schema.Struct({
    entities: Schema.Record(Schema.String, Schema.Unknown),
    connections: Schema.Record(Schema.String, Schema.Unknown),
    requests: Schema.Record(Schema.String, Schema.Unknown),
    mutations: Schema.Record(Schema.String, Schema.Unknown),
  })

export interface RemoteDescriptor<Model extends Schema.Struct<Schema.Struct.Fields>> {
  readonly entities: readonly unknown[]
  readonly Model: Model
}

export interface BoundRemote<AppModel, Store> {
  readonly store: ModelRef<AppModel, Store>
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
  at: <AppModel, Store>(
    _definition: RemoteDescriptor<any>,
    store: ModelRef<AppModel, Store>,
  ): BoundRemote<AppModel, Store> => ({ store }),

  /**
   * A Projection node that reads a `RemoteData` value out of the store. The id
   * is supplied by the caller, usually from a Surface's params.
   */
  select:
    <AppModel, Store, Value>(bound: BoundRemote<AppModel, Store>, selection: Selection<Value>) =>
    (id: string): Projection<AppModel, RemoteData<Value>> => ({
      Model: Schema.Unknown as unknown as Schema.Schema<RemoteData<Value>>,
      dependencies: [],
      requirements: [{ entity: selection.entity, id, fields: selection.fields }],
      read: (root: AppModel): RemoteData<Value> => {
        const remote = bound.store.get(root) as unknown as { readonly entities?: EntityStore }
        const store = remote.entities ?? {}
        const key = entityKey(selection.entity, id)
        if (isTombstone(store, key)) return { _tag: 'NotFound' }
        const values: Record<string, unknown> = {}
        for (const field of selection.fields) {
          const value = readField(store, key, field)
          if (Option.isNone(value)) return { _tag: 'Initial' }
          values[field] = value.value
        }
        return { _tag: 'Ready', value: values as Value }
      },
    }),

  /** The remote requirements a Projection contributes. */
  requirements: <Root, Value>(projection: Projection<Root, Value>): readonly Requirement[] =>
    projection.requirements,
}
