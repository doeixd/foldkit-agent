/**
 * `foldkit-surface` — **Phase 0 inference spike**.
 *
 * Minimal, deliberately non-final implementations of the Surface and Remote
 * descriptors, written only to answer the five inference questions in
 * `REVISION_PLAN.md` §15 (Phase 0). Runtime behaviour is thin; the deliverable
 * is the type surface, pinned by `test/inference.test-d.ts`.
 *
 * Phase 1 replaces the Surface half with the real package. Phase 3 moves the
 * Entity/Selection/Remote half into `foldkit-remote`.
 */
import { Optic, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { MessageUnion } from 'foldkit/message'

// ===========================================================================
// ModelRef and the typed Model tree (Phase 0 cases 1)
// ===========================================================================

export interface ModelRef<Root, Value> {
  readonly Schema: Schema.Schema<Value>
  readonly optic: Optic.Optional<Root, Value>
  readonly dependency: readonly string[]
  readonly read: (root: Root) => Value
}

export type RefTree<Root, F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]: RefNode<Root, F[K]>
}

type RefNode<Root, S> =
  S extends Schema.Struct<infer F>
    ? ModelRef<Root, Schema.Struct.Type<F>> & RefTree<Root, F>
    : S extends Schema.Schema<infer A>
      ? A extends ReadonlyArray<infer E>
        ? ModelRef<Root, ReadonlyArray<E>> & {
            readonly index: (index: number) => ModelRef<Root, Option.Option<E>>
          }
        : A extends Readonly<Record<string, infer V>>
          ? ModelRef<Root, Readonly<Record<string, V>>> & {
              readonly at: (key: string) => ModelRef<Root, Option.Option<V>>
            }
          : ModelRef<Root, A>
      : never

type AnySchema = Schema.Schema<unknown>

function propertyReader(root: unknown, key: string): unknown {
  return root === null || root === undefined ? undefined : (root as Record<string, unknown>)[key]
}

function optionalReader(value: unknown): Option.Option<unknown> {
  return value === undefined ? Option.none() : Option.some(value)
}

function makeTree(
  schema: AnySchema,
  path: readonly string[],
  optic: Optic.Optional<unknown, unknown>,
  read: (root: unknown) => unknown,
): Record<string, unknown> {
  const erasedOptic = optic as {
    key(key: string): Optic.Optional<unknown, unknown>
    at(key: string): Optic.Optional<unknown, unknown>
  }
  const node: Record<string, unknown> = { Schema: schema, optic, dependency: path, read }

  const fields = (schema as { readonly fields?: Schema.Struct.Fields }).fields
  if (fields !== undefined) {
    for (const key of Object.keys(fields)) {
      node[key] = makeTree(fields[key] as AnySchema, [...path, key], erasedOptic.key(key), root =>
        propertyReader(read(root), key),
      )
    }
  }

  node.at = (key: string) =>
    makeTree(schema, [...path, key], erasedOptic.at(key), root =>
      optionalReader(propertyReader(read(root), key)),
    )
  node.index = (index: number) =>
    makeTree(schema, [...path, String(index)], optic, root =>
      optionalReader(
        Array.isArray(read(root)) ? (read(root) as ReadonlyArray<unknown>)[index] : undefined,
      ),
    )
  return node
}

// ===========================================================================
// Projection (Phase 0 case 2)
// ===========================================================================

export type DependencyTree = readonly (readonly string[])[]

export interface Projection<Root, Value> {
  readonly Model: Schema.Schema<Value>
  readonly dependencies: DependencyTree
  readonly read: (root: Root) => Value
}

function makeProjection<Value>(
  Model: Schema.Schema<Value>,
  dependencies: DependencyTree,
  read: (root: unknown) => Value,
): Projection<unknown, Value> {
  return { Model, dependencies, read }
}

type OfSelection<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: true | Projection<Schema.Schema.Type<F[K]>, unknown>
}

type OfValue<F extends Schema.Struct.Fields, Sel> = {
  readonly [K in keyof Sel & keyof F]: Sel[K] extends true
    ? Schema.Schema.Type<F[K]>
    : Sel[K] extends Projection<any, infer V>
      ? V
      : never
}

type EntryValue<E> =
  E extends Projection<any, infer V> ? V : E extends ModelRef<any, infer V> ? V : never

type EntryRoot<E> =
  E extends Projection<infer R, any> ? R : E extends ModelRef<infer R, any> ? R : never

type StructValue<Entries> = {
  readonly [K in keyof Entries]: EntryValue<Entries[K]>
}

export const Projection = {
  of:
    <F extends Schema.Struct.Fields>(schema: Schema.Struct<F>) =>
    <const Sel extends OfSelection<F>>(
      selection: Sel,
    ): Projection<Schema.Struct.Type<F>, OfValue<F, Sel>> => {
      const picked: Record<string, AnySchema> = {}
      const dependencies: (readonly string[])[] = []
      const readers: (readonly [string, (root: unknown) => unknown])[] = []

      for (const key of Object.keys(selection)) {
        const choice = (selection as Record<string, unknown>)[key]
        if (choice === true) {
          picked[key] = schema.fields[key] as AnySchema
          readers.push([key, root => propertyReader(root, key)])
        } else {
          const nested = choice as Projection<unknown, unknown>
          picked[key] = nested.Model
          dependencies.push(...nested.dependencies)
          readers.push([key, root => nested.read(propertyReader(root, key))])
        }
      }

      const read = (root: unknown): unknown => {
        const out: Record<string, unknown> = {}
        for (const [key, reader] of readers) out[key] = reader(root)
        return out
      }
      return makeProjection(Schema.Struct(picked), dependencies, read) as unknown as Projection<
        Schema.Struct.Type<F>,
        OfValue<F, Sel>
      >
    },

  struct: <const Entries extends Record<string, Projection<any, any> | ModelRef<any, any>>>(
    entries: Entries,
  ): Projection<EntryRoot<Entries[keyof Entries]>, StructValue<Entries>> => {
    const picked: Record<string, AnySchema> = {}
    const dependencies: (readonly string[])[] = []
    const readers: (readonly [string, (root: unknown) => unknown])[] = []

    for (const key of Object.keys(entries)) {
      const entry = entries[key] as Projection<unknown, unknown> | ModelRef<unknown, unknown>
      if ('dependencies' in entry) {
        picked[key] = entry.Model
        dependencies.push(...entry.dependencies)
        readers.push([key, entry.read])
      } else {
        picked[key] = entry.Schema
        dependencies.push(entry.dependency)
        readers.push([key, entry.read])
      }
    }

    const read = (root: unknown): unknown => {
      const out: Record<string, unknown> = {}
      for (const [key, reader] of readers) out[key] = reader(root)
      return out
    }
    return makeProjection(Schema.Struct(picked), dependencies, read) as unknown as Projection<
      EntryRoot<Entries[keyof Entries]>,
      StructValue<Entries>
    >
  },

  read: <Root, Value>(projection: Projection<Root, Value>, root: Root): Value =>
    projection.read(root),
}

// ===========================================================================
// Surface (Phase 0 case 3)
// ===========================================================================

export interface AppScope<
  Root,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
> {
  readonly Model: Schema.Struct<F>
  readonly Message: MessageUnion<Cases>
  readonly model: RefTree<Root, F>
}

export interface Surface<Root, Model, Message, Params> {
  readonly name: string
  readonly Params: Schema.Schema<Params> | undefined
  readonly Model: Schema.Schema<Model>
  readonly Message: Schema.Schema<Message>
  readonly messages: readonly unknown[]
  readonly dependencies: DependencyTree
  readonly projection: (params: Params) => Projection<Root, Model>
}

type MsgOf<Ms extends readonly unknown[]> = {
  readonly [K in keyof Ms]: Ms[K] extends (...args: never[]) => infer M ? M : never
}[number]

/**
 * `HtmlBuilder<Message>` is invariant in `Message`: its `MessageUniverse`
 * phantom is `(message: Message) => Message`. Stripping that one symbol key
 * leaves the contravariant element/attribute surface, which a builder for a
 * *superset* of Messages can satisfy.
 */
type ViewBuilder<Message> = Omit<HtmlBuilder<Message>, keyof HtmlBuilder<never> & symbol>

export const Surface = {
  make: <
    F extends Schema.Struct.Fields,
    Cases extends Record<string, Schema.Struct.Fields>,
  >(config: {
    readonly Model: Schema.Struct<F>
    readonly Message: MessageUnion<Cases>
  }): AppScope<Schema.Struct.Type<F>, F, Cases> => ({
    Model: config.Model,
    Message: config.Message,
    model: makeTree(config.Model, [], Optic.id(), root => root) as unknown as RefTree<
      Schema.Struct.Type<F>,
      F
    >,
  }),

  define: <
    Root,
    F extends Schema.Struct.Fields,
    Cases extends Record<string, Schema.Struct.Fields>,
    Params = void,
    Model = unknown,
    const Ms extends readonly unknown[] = readonly [],
  >(
    app: AppScope<Root, F, Cases>,
    name: string,
    config: {
      readonly Params?: Schema.Schema<Params>
      readonly model: (context: {
        readonly model: RefTree<Root, F>
        readonly params: Params
      }) => Projection<Root, Model>
      readonly messages?: Ms
    },
  ): Surface<Root, Model, MsgOf<Ms>, Params> => {
    const projection = (params: Params): Projection<Root, Model> =>
      config.model({ model: app.model, params })
    const first = projection(undefined as unknown as Params)
    return {
      name,
      Params: config.Params,
      Model: first.Model,
      Message: Schema.Never as unknown as Schema.Schema<MsgOf<Ms>>,
      messages: config.messages ?? [],
      dependencies: first.dependencies,
      projection,
    }
  },

  read: <Root, Model, Message, Params>(
    surface: Surface<Root, Model, Message, Params>,
    root: Root,
    params?: Params,
  ): Model => surface.projection(params as Params).read(root),

  view: <Root, Model, Message, Params>(
    surface: Surface<Root, Model, Message, Params>,
    render: (model: Model, h: ViewBuilder<Message>) => Html,
  ): (<AppMessage>(model: Root, h: HtmlBuilder<AppMessage>) => Html) => {
    const projection = surface.projection(undefined as unknown as Params)
    // Sound narrowing, not an unsafe cast: the renderer can only construct
    // Messages from the Surface subset, and the real builder accepts the
    // superset. `HtmlBuilder`'s OnClick returns `{ message: Message }`, so the
    // superset builder is invariant and cannot be *structurally* narrowed.
    return <AppMessage>(root: Root, h: HtmlBuilder<AppMessage>): Html =>
      render(projection.read(root), h as unknown as ViewBuilder<Message>)
  },
}

// ===========================================================================
// Entity, Selection, Remote (Phase 0 cases 4 and 5)
// ===========================================================================

export interface EntityRef<E> {
  readonly entity: E
  readonly id: string
}

export interface EntityDescriptor<Name extends string, F extends Schema.Struct.Fields> {
  readonly name: Name
  readonly schema: Schema.Struct<F>
  readonly fields: F
  readonly ref: (id: Schema.Schema.Type<F['id']>) => EntityRef<EntityDescriptor<Name, F>>
}

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
    ref: id => ({ entity: undefined as unknown as EntityDescriptor<Name, F>, id: String(id) }),
  }),

  ref: <Name extends string, F extends Schema.Struct.Fields>(
    entity: EntityDescriptor<Name, F>,
  ): Schema.Schema<Schema.Struct.Type<F>> => entity.schema as Schema.Schema<Schema.Struct.Type<F>>,

  patch: <Name extends string, F extends Schema.Struct.Fields>(
    _ref: EntityRef<EntityDescriptor<Name, F>>,
    patch: Partial<Schema.Struct.Type<F>>,
  ): Partial<Schema.Struct.Type<F>> => patch,
}

export interface Selection<Value> {
  readonly entity: string
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
      schema: Schema.Struct(picked) as unknown as Schema.Schema<SelectionValue<F, Sel>>,
    }
  },
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

export const Remote = {
  make: <const Entities extends readonly EntityDescriptor<any, any>[]>(config: {
    readonly entities: Entities
    readonly queries?: readonly unknown[]
    readonly mutations?: readonly unknown[]
  }): RemoteDescriptor<ReturnType<typeof remoteModelSchema>> => ({
    entities: config.entities,
    Model: remoteModelSchema(),
  }),

  select: <Model extends Schema.Struct<Schema.Struct.Fields>, Value>(
    _remote: RemoteDescriptor<Model>,
    _selection: Selection<Value>,
  ): RemoteData<Value> => ({
    _tag: 'Initial',
  }),
}
