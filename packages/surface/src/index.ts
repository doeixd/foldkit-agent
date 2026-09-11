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
import { Optic, Option, Result, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { MessageUnion } from 'foldkit/message'

// ===========================================================================
// ModelRef and the typed Model tree (Phase 0 cases 1)
// ===========================================================================

export interface ModelRef<Root, Value> {
  readonly Schema: Schema.Schema<Value>
  readonly optic: Optic.Optional<Root, Value>
  readonly dependency: readonly string[]
  readonly get: (root: Root) => Value
  readonly set: (root: Root, value: Value) => Root
}

/**
 * Low-level escape hatch for a focus with no Model path of its own. Prefer the
 * `App.model` tree; use this for an optic that is not part of the Model.
 */
export const ModelRef = {
  fromOptic: <Root, Value>(
    Schema: Schema.Schema<Value>,
    optic: Optic.Optional<Root, Value>,
    dependency: readonly string[] = [],
  ): ModelRef<Root, Value> => ({
    Schema,
    optic,
    dependency,
    get: root => Result.getOrThrow(optic.getResult(root)),
    set: (root, value) => optic.replace(value, root),
  }),
}

export type RefTree<Root, F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]: RefNode<Root, F[K]>
}

// Tuple-wrapped so the conditional is *non-distributive*: without it,
// `Value = Option<V>` distributes over `None | Some<V>` and `.at()` would return
// a union of two unrelated `ModelRef`s.
type Selectable<Root, Value> = [Value] extends [Option.Option<infer Inner>]
  ? ModelRef<Root, Value> & {
      readonly select: <P>(projection: Projection<Inner, P>) => Projection<Root, Option.Option<P>>
    }
  : ModelRef<Root, Value> & {
      readonly select: <P>(projection: Projection<Value, P>) => Projection<Root, P>
    }

type RefNode<Root, S> =
  S extends Schema.Struct<infer F>
    ? Selectable<Root, Schema.Struct.Type<F>> & RefTree<Root, F>
    : S extends Schema.Schema<infer A>
      ? A extends ReadonlyArray<infer E>
        ? Selectable<Root, ReadonlyArray<E>> & {
            readonly index: (index: number) => Selectable<Root, Option.Option<E>>
          }
        : A extends Readonly<Record<infer K, infer V>>
          ? Selectable<Root, A> & {
              readonly at: (key: K) => Selectable<Root, Option.Option<V>>
            }
          : Selectable<Root, A>
      : never

type AnySchema = Schema.Schema<unknown>

/**
 * Names that belong to the ModelRef surface. A Struct field with one of these
 * names would silently shadow a method, so building the tree rejects it.
 */
const RESERVED_REF_NAMES = new Set([
  'Schema',
  'optic',
  'dependency',
  'read',
  'get',
  'set',
  'at',
  'index',
  'select',
])

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
  get: (root: unknown) => unknown,
  optional = false,
  set?: (root: unknown, value: unknown) => unknown,
): Record<string, unknown> {
  const erasedOptic = optic as {
    key(key: string): Optic.Optional<unknown, unknown>
    at(key: string): Optic.Optional<unknown, unknown>
  }
  // `Optic.at` cannot *insert* or *remove* an absent key (`replace` is a no-op
  // when the prism fails), so optional foci get container-aware setters below.
  const setFocus = set ?? ((root: unknown, value: unknown): unknown => optic.replace(value, root))
  const node: Record<string, unknown> = {
    Schema: schema,
    optic,
    dependency: path,
    get,
    set: setFocus,
  }

  const fields = (schema as { readonly fields?: Schema.Struct.Fields }).fields
  if (fields !== undefined) {
    for (const key of Object.keys(fields)) {
      if (RESERVED_REF_NAMES.has(key)) {
        throw new Error(`Model field "${key}" is reserved by ModelRef`)
      }
      node[key] = makeTree(fields[key] as AnySchema, [...path, key], erasedOptic.key(key), root =>
        propertyReader(get(root), key),
      )
    }
  }

  node.at = (key: string) =>
    makeTree(
      schema,
      [...path, key],
      erasedOptic.at(key),
      root => optionalReader(propertyReader(get(root), key)),
      true,
      (root, value) => {
        const container = get(root) as Record<string, unknown>
        const option = value as Option.Option<unknown>
        if (Option.isSome(option)) {
          return setFocus(root, { ...container, [key]: option.value })
        }
        const { [key]: _removed, ...rest } = container
        return setFocus(root, rest)
      },
    )
  node.index = (index: number) =>
    makeTree(
      schema,
      [...path, String(index)],
      optic,
      root =>
        optionalReader(
          Array.isArray(get(root)) ? (get(root) as ReadonlyArray<unknown>)[index] : undefined,
        ),
      true,
      (root, value) => {
        const array = (Array.isArray(get(root)) ? get(root) : []) as ReadonlyArray<unknown>
        const option = value as Option.Option<unknown>
        const next = Option.isSome(option)
          ? array.map((item, i) => (i === index ? option.value : item))
          : array.filter((_, i) => i !== index)
        return setFocus(root, next)
      },
    )
  node.select = (projection: Projection<unknown, unknown>) => {
    const dependencies = mergeDependencies([path, ...projection.dependencies])
    return optional
      ? makeProjection(Schema.Option(projection.Model), dependencies, root =>
          Option.map(get(root) as Option.Option<unknown>, value => projection.read(value)),
        )
      : makeProjection(projection.Model, dependencies, root => projection.read(get(root)))
  }
  return node
}

// ===========================================================================
// Projection (Phase 0 case 2)
// ===========================================================================

export type DependencyTree = readonly (readonly string[])[]

/** Unions dependency trees, dropping duplicates; the result is a set. */
function mergeDependencies(dependencies: DependencyTree): DependencyTree {
  const seen = new Set<string>()
  const merged: (readonly string[])[] = []
  for (const dependency of dependencies) {
    const key = dependency.join('\u0000')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(dependency)
  }
  return merged
}

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

/**
 * `Schema.Struct({})` is not an empty-object schema: it accepts `{foo:1}`, `[]`,
 * and `"str"` even with `onExcessProperty: 'error'`. A genuinely empty selection
 * needs a `never`-valued record.
 */
function objectSchema(fields: Record<string, AnySchema>): AnySchema {
  return Object.keys(fields).length === 0
    ? Schema.Record(Schema.String, Schema.Never)
    : Schema.Struct(fields)
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
      return makeProjection(
        objectSchema(picked),
        mergeDependencies(dependencies),
        read,
      ) as unknown as Projection<Schema.Struct.Type<F>, OfValue<F, Sel>>
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
        readers.push([key, entry.get])
      }
    }

    const read = (root: unknown): unknown => {
      const out: Record<string, unknown> = {}
      for (const [key, reader] of readers) out[key] = reader(root)
      return out
    }
    return makeProjection(
      objectSchema(picked),
      mergeDependencies(dependencies),
      read,
    ) as unknown as Projection<EntryRoot<Entries[keyof Entries]>, StructValue<Entries>>
  },

  /**
   * Maps a Projection over an array: `array(p): Projection<ReadonlyArray<Root>,
   * ReadonlyArray<Value>>`. Nesting is explicit (an array of arrays stays an
   * array of arrays); there is no flatten or double-wrap.
   */
  array: <Root, Value>(
    projection: Projection<Root, Value>,
  ): Projection<ReadonlyArray<Root>, ReadonlyArray<Value>> => ({
    Model: Schema.Array(projection.Model),
    dependencies: projection.dependencies,
    read: root => root.map(value => projection.read(value)),
  }),

  /** Maps a Projection inside an Option, preserving absence. */
  option: <Root, Value>(
    projection: Projection<Root, Value>,
  ): Projection<Option.Option<Root>, Option.Option<Value>> => ({
    Model: Schema.Option(projection.Model),
    dependencies: projection.dependencies,
    read: root => Option.map(root, value => projection.read(value)),
  }),

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

type AppMessage<Cases extends Record<string, Schema.Struct.Fields>> = Schema.Schema.Type<
  MessageUnion<Cases>
>

/** A Message constructor whose produced Message belongs to the App's universe. */
type MessageConstructor<Cases extends Record<string, Schema.Struct.Fields>> = (
  ...args: never[]
) => AppMessage<Cases>

/**
 * The renderer's builder: the real `HtmlBuilder` with its private
 * `MessageUniverse` phantom removed, so the renderer's `OnClick` accepts only
 * the Surface's Message subset. `HtmlBuilder<M>` stays invariant even without
 * the phantom (`OnClick` returns `{ message: M }`), so a superset builder is
 * not assignable to this; `Surface.view` casts, which is sound because the
 * renderer can only construct subset Messages and the real builder accepts the
 * superset.
 */
type ViewBuilder<Message> = Omit<HtmlBuilder<Message>, keyof HtmlBuilder<never> & symbol>

/** A renderer for a Surface's projected Model, with its Message set narrowed. */
export type Renderer<Model, Message> = (model: Model, h: ViewBuilder<Message>) => Html

/** `unknown` when `Sub` is a subtype of `Super`, `never` otherwise. */
type Subset<Sub, Super> = [Sub] extends [Super] ? unknown : never

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
    const Ms extends readonly MessageConstructor<Cases>[] = readonly [],
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

  /**
   * Binds a renderer to a Surface's projected Model and Message set. A
   * type-level binder: the renderer already has this shape, but `Model` and
   * `Message` are derived from the Surface instead of written by hand.
   */
  view: <Root, Model, Message, Params>(
    _surface: Surface<Root, Model, Message, Params>,
    render: Renderer<Model, Message>,
  ): Renderer<Model, Message> => render,

  /**
   * The application boundary: consume the Root Model, project it, and hand the
   * projected Model to the renderer. `Subset` rejects a Surface whose Messages
   * the application builder cannot route.
   */
  rootView: <Root, Model, Message, Params>(
    surface: Surface<Root, Model, Message, Params>,
    params: Params,
    render: Renderer<Model, Message>,
  ): (<AppMessage>(
    root: Root,
    h: HtmlBuilder<AppMessage> & Subset<Message, AppMessage>,
  ) => Html) => {
    const projection = surface.projection(params)
    // Sound narrowing: the renderer can only construct this Surface's Messages,
    // and `Subset` guarantees the application builder accepts them.
    return <AppMessage>(
      root: Root,
      h: HtmlBuilder<AppMessage> & Subset<Message, AppMessage>,
    ): Html => render(projection.read(root), h as unknown as ViewBuilder<Message>)
  },

  /**
   * Embeds a child renderer in a parent view. `ParentModel extends ChildModel`
   * enforces "child Model requirement ⊆ parent projected Model"; `Subset`
   * enforces "child Message set ⊆ parent Message set".
   */
  embed:
    <ChildModel, ChildMessage>(child: Renderer<ChildModel, ChildMessage>) =>
    <ParentModel extends ChildModel, ParentMessage>(
      model: ParentModel,
      h: ViewBuilder<ParentMessage> & Subset<ChildMessage, ParentMessage>,
    ): Html =>
      child(model, h as unknown as ViewBuilder<ChildMessage>),

  /**
   * An explicit collection of Surfaces for one App; there is no hidden global
   * registry. Duplicate names are rejected here so a diagnostic name cannot
   * silently collide.
   */
  registry: <
    Root,
    F extends Schema.Struct.Fields,
    Cases extends Record<string, Schema.Struct.Fields>,
  >(
    app: AppScope<Root, F, Cases>,
    surfaces: readonly Surface<Root, any, any, any>[],
  ): {
    readonly app: AppScope<Root, F, Cases>
    readonly surfaces: readonly Surface<Root, any, any, any>[]
  } => {
    const seen = new Set<string>()
    for (const surface of surfaces) {
      if (seen.has(surface.name)) {
        throw new Error(`Duplicate Surface name: ${surface.name}`)
      }
      seen.add(surface.name)
    }
    return { app, surfaces }
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
