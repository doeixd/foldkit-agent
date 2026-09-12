/**
 * `foldkit-surface` — **Phase 0 inference spike**.
 *
 * Minimal, deliberately non-final implementations of the Surface and Remote
 * descriptors, written only to answer the five inference questions in
 * `docs/design/REVISION_PLAN.md` §15 (Phase 0). Runtime behaviour is thin; the deliverable
 * is the type surface, pinned by `test/inference.test-d.ts`.
 *
 * Phase 1 replaces the Surface half with the real package. Phase 3 moves the
 * Entity/Selection/Remote half into `foldkit-remote`.
 */
import { Optic, Option, Result, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import type { MessageUnion } from 'foldkit/message'
import type * as Update from 'foldkit/update'

// ===========================================================================
// ModelRef and the typed Model tree (Phase 0 cases 1)
// ===========================================================================

export interface ModelRef<Root, Value, Encoded = unknown> {
  /** A pure codec: Foldkit Model fields carry no decoding or encoding services. */
  readonly Schema: Schema.Codec<Value, Encoded, never, never>
  readonly optic: Optic.Optional<Root, Value>
  readonly dependency: readonly string[]
  readonly get: (root: Root) => Value
  readonly set: (root: Root, value: Value) => Root
}

/**
 * A `ModelRef` generated for a named Model field. `key` is the literal field
 * name, so a reference-based selection can infer its output keys without a
 * parallel field registry or string paths.
 */
export interface FieldRef<
  Root,
  Value,
  Key extends string = string,
  Encoded = unknown,
> extends ModelRef<Root, Value, Encoded> {
  readonly key: Key
  /** The application definition this field was generated from. */
  readonly owner: object
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
    Schema: Schema as unknown as ModelRef<Root, Value>['Schema'],
    optic,
    dependency,
    get: root => Result.getOrThrow(optic.getResult(root)),
    set: (root, value) => optic.replace(value, root),
  }),
}

export type RefTree<Root, F extends Schema.Struct.Fields> = {
  readonly [K in keyof F & string]: RefNode<Root, F[K], K>
}

// Tuple-wrapped so the conditional is *non-distributive*: without it,
// `Value = Option<V>` distributes over `None | Some<V>` and `.at()` would return
// a union of two unrelated `ModelRef`s.
type Selectable<Root, Value, Key extends string, Encoded = unknown> = [Value] extends [
  Option.Option<infer Inner>,
]
  ? FieldRef<Root, Value, Key, Encoded> & {
      readonly select: <P>(projection: Projection<Inner, P>) => Projection<Root, Option.Option<P>>
    }
  : FieldRef<Root, Value, Key, Encoded> & {
      readonly select: <P>(projection: Projection<Value, P>) => Projection<Root, P>
    }

/**
 * A dynamic focus from `.at`/`.index`. Deliberately not a `FieldRef`: its key is
 * a record key or index, not a Model field, so a static `Projection.pick` cannot
 * infer a field name from it.
 */
type OptionalRef<Root, Value> = [Value] extends [Option.Option<infer Inner>]
  ? ModelRef<Root, Value> & {
      readonly select: <P>(projection: Projection<Inner, P>) => Projection<Root, Option.Option<P>>
    }
  : ModelRef<Root, Value> & {
      readonly select: <P>(projection: Projection<Value, P>) => Projection<Root, P>
    }

type RefNode<Root, S, Key extends string> =
  S extends Schema.Codec<infer A, infer Encoded, any, any>
    ? S extends Schema.Struct<infer F>
      ? Selectable<Root, A, Key, Encoded> & RefTree<Root, F>
      : A extends ReadonlyArray<infer E>
        ? Selectable<Root, A, Key, Encoded> & {
            readonly index: (index: number) => OptionalRef<Root, Option.Option<E>>
          }
        : A extends Readonly<Record<infer K extends string, infer V>>
          ? Selectable<Root, A, Key, Encoded> & {
              readonly at: (key: K) => OptionalRef<Root, Option.Option<V>>
            }
          : Selectable<Root, A, Key, Encoded>
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
  'key',
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

/** Reads the tag off a Foldkit Message constructor without constructing one. */
const messageTag = (constructor: unknown): string | undefined => {
  const literal = (constructor as { fields?: { _tag?: { ast?: { literal?: unknown } } } }).fields
    ?._tag?.ast?.literal
  return typeof literal === 'string' ? literal : undefined
}

function makeTree(
  schema: AnySchema,
  path: readonly string[],
  optic: Optic.Optional<unknown, unknown>,
  get: (root: unknown) => unknown,
  optional = false,
  set: ((root: unknown, value: unknown) => unknown) | undefined,
  owner: object,
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
    key: path[path.length - 1] ?? '',
    owner,
    get,
    set: setFocus,
  }

  const fields = (schema as { readonly fields?: Schema.Struct.Fields }).fields
  if (fields !== undefined) {
    for (const key of Object.keys(fields)) {
      if (RESERVED_REF_NAMES.has(key)) {
        throw new Error(`Model field "${key}" is reserved by ModelRef`)
      }
      node[key] = makeTree(
        fields[key] as AnySchema,
        [...path, key],
        erasedOptic.key(key),
        root => propertyReader(get(root), key),
        false,
        undefined,
        owner,
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
      owner,
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
      owner,
    )
  node.select = (projection: Projection<unknown, unknown>) => {
    const dependencies = mergeDependencies([path, ...projection.dependencies])
    return optional
      ? makeProjection(
          Schema.Option(projection.Model),
          dependencies,
          projection.requirements,
          root => Option.map(get(root) as Option.Option<unknown>, value => projection.read(value)),
        )
      : makeProjection(projection.Model, dependencies, projection.requirements, root =>
          projection.read(get(root)),
        )
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

/**
 * A required slice of a remote entity, contributed by a remote `Projection`
 * node. This is dependency metadata, so it lives in Surface; Remote consumes it.
 * `windows` carries a pagination window per relation field (Remote's
 * `QueryWindow` is not visible here, so the shape is declared locally).
 */
export interface Window {
  readonly first?: number | undefined
  readonly last?: number | undefined
  readonly after?: string | undefined
  readonly before?: string | undefined
}

export interface Requirement {
  readonly entity: string
  readonly id: string
  readonly fields: readonly string[]
  readonly windows?: Readonly<Record<string, Window>> | undefined
}

/** Unions requirements for the same entity + id, dropping duplicate fields. */
function mergeRequirements(requirements: readonly Requirement[]): readonly Requirement[] {
  const grouped = new Map<
    string,
    {
      entity: string
      id: string
      fields: string[]
      seen: Set<string>
      windows: Map<string, Window>
    }
  >()
  for (const requirement of requirements) {
    const key = `${requirement.entity}\u0000${requirement.id}`
    let group = grouped.get(key)
    if (group === undefined) {
      group = {
        entity: requirement.entity,
        id: requirement.id,
        fields: [],
        seen: new Set(),
        windows: new Map(),
      }
      grouped.set(key, group)
    }
    for (const field of requirement.fields) {
      if (group.seen.has(field)) continue
      group.seen.add(field)
      group.fields.push(field)
    }
    // Later windows win; a duplicate is a caller bug, not a merge policy.
    for (const [field, window] of Object.entries(requirement.windows ?? {})) {
      group.windows.set(field, window)
    }
  }
  return [...grouped.values()].map(group => ({
    entity: group.entity,
    id: group.id,
    fields: group.fields,
    ...(group.windows.size === 0 ? {} : { windows: Object.fromEntries(group.windows) }),
  }))
}

export interface Projection<Root, Value> {
  readonly Model: Schema.Schema<Value>
  readonly dependencies: DependencyTree
  readonly requirements: readonly Requirement[]
  readonly read: (root: Root) => Value
}

/**
 * A projection Surface can install back into a Model. Public reads use the
 * read-only `Projection`; only a writable selection carries installation.
 * `set` writes exactly the declared fields, so an excess field in an untrusted
 * value cannot reach local state.
 */
export interface WritableProjection<Model, Fields extends Schema.Struct.Fields> {
  readonly schema: Schema.Struct<Fields>
  readonly dependencies: DependencyTree
  readonly get: (model: Model) => Schema.Struct.Type<Fields>
  readonly set: (model: Model, shared: Schema.Struct.Type<Fields>) => Model
}

function makeProjection<Value>(
  Model: Schema.Schema<Value>,
  dependencies: DependencyTree,
  requirements: readonly Requirement[],
  read: (root: unknown) => Value,
): Projection<unknown, Value> {
  return { Model, dependencies, requirements, read }
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

type EntryRoots<Entries> = { readonly [K in keyof Entries]: EntryRoot<Entries[K]> }

/** `true` when the union has more than one member. Used to reject mixed roots. */
type IsUnion<T, U = T> = [T] extends [never]
  ? false
  : T extends unknown
    ? [U] extends [T]
      ? false
      : true
    : never

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
      const requirements: Requirement[] = []
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
          requirements.push(...nested.requirements)
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
        mergeRequirements(requirements),
        read,
      ) as unknown as Projection<Schema.Struct.Type<F>, OfValue<F, Sel>>
    },

  struct: <const Entries extends Record<string, Projection<any, any> | ModelRef<any, any>>>(
    entries: Entries & (IsUnion<EntryRoots<Entries>[keyof Entries]> extends true ? never : unknown),
  ): Projection<EntryRoot<Entries[keyof Entries]>, StructValue<Entries>> => {
    const picked: Record<string, AnySchema> = {}
    const dependencies: (readonly string[])[] = []
    const requirements: Requirement[] = []
    const readers: (readonly [string, (root: unknown) => unknown])[] = []

    for (const key of Object.keys(entries)) {
      const entry = entries[key] as Projection<unknown, unknown> | ModelRef<unknown, unknown>
      if ('dependencies' in entry) {
        picked[key] = entry.Model
        dependencies.push(...entry.dependencies)
        requirements.push(...entry.requirements)
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
      mergeRequirements(requirements),
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
    requirements: projection.requirements,
    read: root => root.map(value => projection.read(value)),
  }),

  /** Maps a Projection inside an Option, preserving absence. */
  option: <Root, Value>(
    projection: Projection<Root, Value>,
  ): Projection<Option.Option<Root>, Option.Option<Value>> => ({
    Model: Schema.Option(projection.Model),
    dependencies: projection.dependencies,
    requirements: projection.requirements,
    read: root => Option.map(root, value => projection.read(value)),
  }),

  read: <Root, Value>(projection: Projection<Root, Value>, root: Root): Value =>
    projection.read(root),

  /**
   * Low-level escape hatch: a Projection from a Schema and a reader, for
   * projections not derived from ModelRefs (agent context, adapters). Prefer
   * `of`/`struct`/`select`; dependencies default to empty.
   */
  fromReader: <Root, Value>(
    Model: Schema.Schema<Value>,
    read: (root: Root) => Value,
    options?: {
      readonly dependencies?: DependencyTree
      readonly requirements?: readonly Requirement[]
    },
  ): Projection<Root, Value> => ({
    Model,
    dependencies: options?.dependencies ?? [],
    requirements: options?.requirements ?? [],
    read,
  }),

  /**
   * Derives a writable projection from generated Model field references:
   * `Projection.pick(App.model.todos, App.model.selectedTodoId)` infers
   * `{ todos, selectedTodoId }` and its codec. Every reference must share one
   * Root; a raw optic or an unrelated application is rejected. Repeated
   * identical members deduplicate; a conflicting definition throws.
   */
  pick: <const Refs extends readonly FieldRef<any, any, string>[]>(
    ...refs: Refs & (IsUnion<RefRoots<Refs>[number]> extends true ? never : unknown)
  ): WritableProjection<RefRoots<Refs>[number], PickFields<Refs>> => {
    const selected = [...refs]
    // Two applications can have structurally identical Models, so the root type
    // check cannot separate them; the owner token can.
    const owner = selected[0]?.owner
    for (const ref of selected) {
      if (ref.owner !== owner) {
        throw new Error('Projection.pick: references from different applications')
      }
    }
    const fields: Record<string, AnySchema> = {}
    for (const ref of selected) {
      const existing = fields[ref.key]
      if (existing !== undefined) {
        if (existing === ref.Schema) continue
        throw new Error(`Projection.pick: conflicting definitions for "${ref.key}"`)
      }
      fields[ref.key] = ref.Schema
    }
    return {
      schema: objectSchema(fields) as never,
      dependencies: mergeDependencies(selected.map(ref => ref.dependency)),
      get: model => {
        const out: Record<string, unknown> = {}
        for (const ref of selected) out[ref.key] = ref.get(model as never)
        return out as never
      },
      set: (model, shared) => {
        let next = model
        for (const ref of selected)
          next = ref.set(next as never, (shared as Record<string, unknown>)[ref.key] as never)
        return next
      },
    }
  },

  /**
   * Merges disjoint writable projections into one: `Projection.compose(Todos,
   * Selection)`. Every projection must own the same Model; a field defined twice
   * with a different codec throws, while an identical definition deduplicates.
   * `set` installs each part, so composed fields keep their own write behaviour.
   */
  compose: <const Ps extends readonly WritableProjection<any, any>[]>(
    ...projections: Ps & (IsUnion<ProjectionModel<Ps[number]>> extends true ? never : unknown)
  ): WritableProjection<ProjectionModel<Ps[number]>, MergeFields<Ps>> => {
    const parts = [...projections]
    const fields: Record<string, AnySchema> = {}
    for (const part of parts) {
      for (const [key, codec] of Object.entries(part.schema.fields)) {
        const existing = fields[key]
        if (existing !== undefined) {
          if (existing === codec) continue
          throw new Error(`Projection.compose: conflicting definitions for "${key}"`)
        }
        fields[key] = codec as AnySchema
      }
    }
    return {
      schema: objectSchema(fields) as never,
      dependencies: mergeDependencies(parts.flatMap(part => [...part.dependencies])),
      get: model => {
        const out: Record<string, unknown> = {}
        for (const part of parts) Object.assign(out, part.get(model as never))
        return out as never
      },
      set: (model, shared) => {
        let next = model
        // Each part reads only its own fields from the merged value.
        for (const part of parts) next = part.set(next as never, shared as never)
        return next
      },
    }
  },
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
  /** Identity token shared by this application's references and subsets. */
  readonly owner: object
}

export interface SurfaceInspection {
  readonly name: string
  readonly dependencies: DependencyTree
  readonly requirements: readonly Requirement[]
  readonly emits: readonly unknown[]
}

export interface Surface<Root, Model, Message, Params> {
  readonly name: string
  /** Identity token of the application this Surface belongs to. */
  readonly owner: object
  readonly Params: Schema.Schema<Params> | undefined
  readonly Message: Schema.Schema<Message>
  readonly messages: readonly unknown[]
  readonly projection: (params: Params) => Projection<Root, Model>
}

type MsgOf<Ms extends readonly unknown[]> = {
  readonly [K in keyof Ms]: Ms[K] extends (...args: never[]) => infer M ? M : never
}[number]

/** The union of Messages a tuple of constructors produces. */
type SubsetOf<Ms extends readonly unknown[]> = Ms[number] extends (...args: never[]) => infer M
  ? M
  : never

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

type RefRoot<R> = R extends ModelRef<infer Root, any> ? Root : never

type RefRoots<Refs extends readonly unknown[]> = {
  readonly [K in keyof Refs]: RefRoot<Refs[K]>
}

/** The struct fields a reference selection produces, keyed by each ref's field. */
type PickFields<Refs extends readonly FieldRef<any, any, string>[]> = {
  readonly [R in Refs[number] as R['key']]: R['Schema']
}

type ProjectionModel<P> = P extends WritableProjection<infer M, any> ? M : never

type ProjectionFields<P> = P extends WritableProjection<any, infer F> ? F : never

type Merge2<A, B> = {
  readonly [K in keyof A | keyof B]: K extends keyof A ? A[K] : K extends keyof B ? B[K] : never
}

/** Merges the fields of several projections; an overlapping key is rejected at runtime. */
export type MergeFields<Ps extends readonly WritableProjection<any, any>[]> = Ps extends readonly [
  infer Head extends WritableProjection<any, any>,
  ...infer Tail extends readonly WritableProjection<any, any>[],
]
  ? Merge2<ProjectionFields<Head>, MergeFields<Tail>>
  : {}

/**
 * An application definition: the Model and Message schemas and the generated
 * field references. It is data, not a running instance, so it can be inspected
 * without mounting anything. Context, replication, and validation all read the
 * same `App.fields` references.
 */
export interface Application<
  Root,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
> extends AppScope<Root, F, Cases> {
  /** Reference-based field selection: `App.fields.todos`. */
  readonly fields: RefTree<Root, F>
}

/**
 * An `Application` that also carries the initial Model and the transition
 * function, so a replicator can derive the initial shared value and replay.
 * `Resources` is whatever `update`'s Commands need.
 */
export interface RunnableApplication<
  Root,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Resources = never,
> extends Application<Root, F, Cases> {
  readonly initial: Root
  readonly update: (
    model: Root,
    message: Schema.Schema.Type<MessageUnion<Cases>>,
  ) => Update.Return<Root, Schema.Schema.Type<MessageUnion<Cases>>, Resources>
}

declare const messageSubsetRoot: unique symbol

/**
 * A typed subset of one application's Messages: the selected constructors, a
 * codec for exactly those variants, and a runtime membership test. Surface does
 * not label a subset agent-visible, durable, or presence; `Agent` and `Sync`
 * attach their own policy to the same value.
 */
/** The union of encoded types a tuple of constructor schemas produces. */
type SubsetEncoded<Ms extends readonly unknown[]> =
  Ms[number] extends Schema.Codec<any, infer Encoded, any, any> ? Encoded : never

export interface MessageSet<
  Root,
  Message,
  Subset extends Message,
  Ms extends readonly ((...args: never[]) => Message)[],
  Cases extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  Encoded = unknown,
> {
  /** Phantom owner, so a subset cannot be crossed between applications. */
  readonly [messageSubsetRoot]?: Root
  /** The application identity token, checked when subsets compose. */
  readonly owner: object
  readonly constructors: Ms
  /** A pure codec for exactly the selected variants. */
  readonly schema: Schema.Codec<Subset, Encoded, never, never>
  readonly tags: ReadonlySet<string>
  readonly includes: (message: Message) => message is Subset
}

const makeScope = <
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
>(config: {
  readonly Model: Schema.Struct<F>
  readonly Message: MessageUnion<Cases>
}): AppScope<Schema.Struct.Type<F>, F, Cases> => {
  // One token per application, so a selection cannot silently mix two
  // applications whose Models happen to be structurally identical.
  const owner: object = {}
  return {
    Model: config.Model,
    Message: config.Message,
    owner,
    model: makeTree(
      config.Model,
      [],
      Optic.id(),
      root => root,
      false,
      undefined,
      owner,
    ) as unknown as RefTree<Schema.Struct.Type<F>, F>,
  }
}

/**
 * Captures an application's pure references once. `initial` and `update` are
 * optional: an agent needs only the Model, Message, and field references, while
 * a replicator needs them to derive the initial shared value and replay. A
 * `RunnableApplication` is returned when both are supplied.
 */
function application<
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Resources = never,
  ManagedResourceServices = never,
>(config: {
  readonly Model: Schema.Struct<F>
  readonly Message: MessageUnion<Cases>
  readonly initial: Schema.Struct.Type<F>
  readonly update: (
    model: Schema.Struct.Type<F>,
    message: Schema.Schema.Type<MessageUnion<Cases>>,
  ) => Update.Return<
    Schema.Struct.Type<F>,
    Schema.Schema.Type<MessageUnion<Cases>>,
    Resources | ManagedResourceServices
  >
}): RunnableApplication<Schema.Struct.Type<F>, F, Cases, Resources | ManagedResourceServices>
function application<
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
>(config: {
  readonly Model: Schema.Struct<F>
  readonly Message: MessageUnion<Cases>
}): Application<Schema.Struct.Type<F>, F, Cases>
function application(config: any): any {
  const scope = makeScope(config)
  return { ...scope, initial: config.initial, fields: scope.model, update: config.update }
}

type ConstructorOfSubset<S> = S extends MessageSet<any, any, any, infer Ms, any> ? Ms : never
type ValueOfSubset<S> = S extends MessageSet<any, any, infer V, any, any> ? V : never
type RootOfSubset<S> = S extends MessageSet<infer R, any, any, any, any> ? R : never
type MessageOfSubset<S> = S extends MessageSet<any, infer M, any, any, any> ? M : never
type CasesOfSubset<S> = S extends MessageSet<any, any, any, any, infer C> ? C : never

type Concat<A extends readonly unknown[], B extends readonly unknown[]> = [...A, ...B]

/** Concatenates the constructor tuples of several subsets, preserving each. */
export type MergeConstructors<Subs extends readonly MessageSet<any, any, any, any, any>[]> =
  Subs extends readonly [
    infer Head extends MessageSet<any, any, any, any, any>,
    ...infer Tail extends readonly MessageSet<any, any, any, any, any>[],
  ]
    ? Concat<ConstructorOfSubset<Head>, MergeConstructors<Tail>>
    : []

/** Typed Message subsets of one application, by constructor reference. */
export const MessageSet = {
  /**
   * Selects a typed Message subset by constructor reference:
   * `MessageSet.make(App, [Message.CreatedTodo, Message.RenamedTodo])`. Each
   * constructor must be this application's own variant; a duplicate or a variant
   * from another union throws.
   */
  make: <
    Root,
    F extends Schema.Struct.Fields,
    Cases extends Record<string, Schema.Struct.Fields>,
    const Ms extends readonly MessageConstructor<Cases>[],
  >(
    app: AppScope<Root, F, Cases>,
    messages: Ms,
  ): MessageSet<
    Root,
    Schema.Schema.Type<MessageUnion<Cases>>,
    SubsetOf<Ms> & Schema.Schema.Type<MessageUnion<Cases>>,
    Ms,
    Cases,
    SubsetEncoded<Ms>
  > => {
    const tags = new Set<string>()
    for (const constructor of messages) {
      const tag = messageTag(constructor)
      if (tag === undefined) {
        throw new Error('MessageSet.make: expected Message constructors')
      }
      if ((app.Message as unknown as Record<string, unknown>)[tag] !== constructor) {
        throw new Error(
          `MessageSet.make: "${tag}" is not a variant of this application's Message union`,
        )
      }
      if (tags.has(tag)) throw new Error(`MessageSet.make: duplicate "${tag}"`)
      tags.add(tag)
    }
    return {
      owner: app.owner,
      constructors: messages,
      schema: Schema.Union([...messages] as unknown as ReadonlyArray<
        Schema.Schema<unknown>
      >) as unknown as Schema.Codec<
        SubsetOf<Ms> & Schema.Schema.Type<MessageUnion<Cases>>,
        SubsetEncoded<Ms>,
        never,
        never
      >,
      tags,
      includes: (message): message is SubsetOf<Ms> & Schema.Schema.Type<MessageUnion<Cases>> =>
        tags.has((message as { readonly _tag?: string })._tag ?? ''),
    }
  },

  /**
   * Unions several Message subsets into one. Every subset must belong to the
   * same application; a tag declared twice throws. Disjoint feature modules can
   * each declare their own subset and compose them here.
   */
  union: <const Subs extends readonly MessageSet<any, any, any, any, any>[]>(
    ...subsets: Subs
  ): MessageSet<
    RootOfSubset<Subs[number]>,
    MessageOfSubset<Subs[number]>,
    ValueOfSubset<Subs[number]>,
    MergeConstructors<Subs>,
    CasesOfSubset<Subs[number]>,
    SubsetEncoded<MergeConstructors<Subs>>
  > => {
    const parts = [...subsets]
    const owner = parts[0]?.owner
    const tags = new Set<string>()
    const constructors: Array<Schema.Schema<unknown>> = []
    for (const part of parts) {
      if (part.owner !== owner) {
        throw new Error('MessageSet.union: subsets from different applications')
      }
      for (const constructor of part.constructors) {
        const tag = messageTag(constructor)
        if (tag === undefined) continue
        if (tags.has(tag)) throw new Error(`MessageSet.union: duplicate "${tag}"`)
        tags.add(tag)
        constructors.push(constructor as Schema.Schema<unknown>)
      }
    }
    return {
      owner: owner as object,
      constructors: constructors as never,
      schema: Schema.Union(constructors) as unknown as Schema.Codec<
        ValueOfSubset<Subs[number]>,
        SubsetEncoded<MergeConstructors<Subs>>,
        never,
        never
      >,
      tags,
      includes: (message): message is ValueOfSubset<Subs[number]> =>
        tags.has((message as { readonly _tag?: string })._tag ?? ''),
    }
  },
}

export const Surface = {
  application,

  make: <
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
    // Deliberately no eager `projection(undefined)`: a parameterized Surface's
    // projection may read `params`.
    const projection = (params: Params): Projection<Root, Model> =>
      config.model({ model: app.model, params })
    return {
      name,
      owner: app.owner,
      Params: config.Params,
      Message: Schema.Never as unknown as Schema.Schema<MsgOf<Ms>>,
      messages: config.messages ?? [],
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
   * A Surface as a `Contract` for `Module`: what it observes, requires, and may
   * emit. A parameterized Surface needs its `params` to build the projection.
   */
  contract: <Root, Model, Message, Params>(
    surface: Surface<Root, Model, Message, Params>,
    params: Params,
  ): Contract => {
    const projection = surface.projection(params)
    return {
      kind: 'surface',
      name: surface.name,
      owner: surface.owner,
      owns: [],
      observes: projection.dependencies,
      messages: surface.messages.map(messageTag).filter((tag): tag is string => tag !== undefined),
      requirements: projection.requirements,
    }
  },

  /**
   * Pure introspection for DevTools: what a Surface observes (dependencies,
   * requirements) and what it may emit. No behavior change, no I/O.
   */
  inspect: <Root, Model, Message, Params>(
    surface: Surface<Root, Model, Message, Params>,
    params: Params,
  ): SurfaceInspection => {
    const projection = surface.projection(params)
    return {
      name: surface.name,
      dependencies: projection.dependencies,
      requirements: projection.requirements,
      emits: surface.messages,
    }
  },
}

// ===========================================================================
// Entity, Selection, Remote moved to `foldkit-remote` (Phase 3).
// ===========================================================================

// ===========================================================================
// Module: the pure composition root
// ===========================================================================

/**
 * What one contract claims about an application, as data. Sync, Remote, and
 * Agent attach one to the values they produce; `Surface.contract` derives one
 * from a Surface. `owns` are the Model paths the contract is the authority for
 * (a replicated projection, a remote store); `observes` are the paths it reads.
 */
export interface Contract {
  readonly kind: string
  readonly name: string
  /** The application's identity token; absent when the value cannot know it. */
  readonly owner?: object | undefined
  readonly owns: DependencyTree
  readonly observes: DependencyTree
  /** Message tags the contract may cause, expose, or record. */
  readonly messages: readonly string[]
  readonly requirements: readonly Requirement[]
}

/** Contracts of one application, in declaration order. Data, not a runtime. */
export interface Module<
  Root,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
> {
  readonly app: AppScope<Root, F, Cases>
  readonly contracts: readonly Contract[]
}

export interface Finding {
  readonly rule:
    | 'foreign-contract'
    | 'duplicate-name'
    | 'ownership-overlap'
    | 'message-claimed-twice'
    | 'unknown-path'
    | 'unknown-message'
  /** `kind:name` of each contract involved. */
  readonly contracts: readonly string[]
  readonly message: string
}

/** Who owns a Model path; `undefined` is local state. */
export interface Ownership {
  readonly path: readonly string[]
  readonly owner: { readonly kind: string; readonly name: string } | undefined
}

export interface ModuleManifest {
  readonly fields: readonly string[]
  readonly messages: readonly string[]
  readonly ownership: readonly Ownership[]
  readonly contracts: readonly Omit<Contract, 'owner'>[]
  readonly findings: readonly Finding[]
}

/** A value `Module.make` accepts: a contract, a value carrying one, or a Surface without params. */
export type ModuleItem<Root> =
  Contract | { readonly contract: Contract } | Surface<Root, any, any, void>

const label = (contract: Contract): string => `${contract.kind}:${contract.name}`
const pathKey = (path: readonly string[]): string => path.join('.')
const isPrefix = (prefix: readonly string[], path: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index])

// A carried contract wins: a sync contract also has a `projection` (writable, not a function).
const toContract = <Root>(item: ModuleItem<Root>): Contract =>
  'contract' in item
    ? item.contract
    : 'projection' in item
      ? Surface.contract(item, undefined)
      : item

const applicationTags = (app: AppScope<any, any, any>): readonly string[] =>
  Object.entries(app.Message as unknown as Record<string, unknown>)
    .filter(([key, value]) => messageTag(value) === key)
    .map(([key]) => key)

/** Contracts that own at least one path, with a stable label. */
const owners = (module: Module<any, any, any>) =>
  module.contracts.filter(contract => contract.owns.length > 0)

/**
 * Collects an application's contracts as pure data so their relationships can
 * be validated and inspected without starting a runtime.
 *
 * ```ts
 * const Project = Module.make(App, [BoardSurface, ProjectSync, ProjectRemote, ProjectAgent])
 * Module.validate(Project) // findings, or []
 * Module.toMarkdown(Project)
 * ```
 */
export const Module = {
  make: <Root, F extends Schema.Struct.Fields, Cases extends Record<string, Schema.Struct.Fields>>(
    app: AppScope<Root, F, Cases>,
    items: readonly ModuleItem<Root>[] = [],
  ): Module<Root, F, Cases> => ({ app, contracts: items.map(toContract) }),

  /** A new Module with more contracts; the input is unchanged. */
  add: <Root, F extends Schema.Struct.Fields, Cases extends Record<string, Schema.Struct.Fields>>(
    module: Module<Root, F, Cases>,
    ...items: readonly ModuleItem<Root>[]
  ): Module<Root, F, Cases> => ({
    app: module.app,
    contracts: [...module.contracts, ...items.map(toContract)],
  }),

  /**
   * Cross-contract invariants the types cannot express: a contract from another
   * application, a duplicate `kind:name`, two owners of overlapping Model paths,
   * a Message recorded by two replication contracts, and a path or Message the
   * application does not declare.
   */
  validate: (module: Module<any, any, any>): readonly Finding[] => {
    const findings: Finding[] = []
    const fields = new Set(Object.keys(module.app.Model.fields))
    const tags = new Set(applicationTags(module.app))
    const seen = new Map<string, Contract>()

    for (const contract of module.contracts) {
      const name = label(contract)
      if (contract.owner !== undefined && contract.owner !== module.app.owner)
        findings.push({
          rule: 'foreign-contract',
          contracts: [name],
          message: `${name} belongs to a different application`,
        })
      const duplicate = seen.get(name)
      if (duplicate !== undefined && duplicate !== contract)
        findings.push({
          rule: 'duplicate-name',
          contracts: [name],
          message: `${name} is declared twice`,
        })
      seen.set(name, contract)
      for (const path of [...contract.owns, ...contract.observes]) {
        const head = path[0]
        if (head === undefined || !fields.has(head))
          findings.push({
            rule: 'unknown-path',
            contracts: [name],
            message: `${name} references "${pathKey(path)}", which is not a Model field`,
          })
      }
      for (const tag of contract.messages)
        if (!tags.has(tag))
          findings.push({
            rule: 'unknown-message',
            contracts: [name],
            message: `${name} names "${tag}", which is not a Message of this application`,
          })
    }

    // The same value listed twice is one owner, as `duplicate-name` treats it.
    const owning = [...new Set(owners(module))]
    for (let i = 0; i < owning.length; i += 1)
      for (let j = i + 1; j < owning.length; j += 1) {
        const a = owning[i]!
        const b = owning[j]!
        for (const pa of a.owns)
          for (const pb of b.owns)
            // An empty path is reported as `unknown-path`, not as owning everything.
            if (pa.length > 0 && pb.length > 0 && (isPrefix(pa, pb) || isPrefix(pb, pa)))
              findings.push({
                rule: 'ownership-overlap',
                contracts: [label(a), label(b)],
                message: `${label(a)} owns "${pathKey(pa)}" and ${label(b)} owns "${pathKey(pb)}"`,
              })
      }

    const recorded = new Map<string, Contract>()
    for (const contract of module.contracts.filter(contract => contract.kind === 'sync'))
      for (const tag of contract.messages) {
        const other = recorded.get(tag)
        if (other !== undefined && other !== contract)
          findings.push({
            rule: 'message-claimed-twice',
            contracts: [label(other), label(contract)],
            message: `"${tag}" is durable in both ${label(other)} and ${label(contract)}`,
          })
        else recorded.set(tag, contract)
      }

    return findings
  },

  /**
   * The application's fields and Messages, who owns each Model path (local when
   * no contract does), every contract, and the findings. Reproducible for a
   * given Module, so it can be committed and diffed.
   */
  manifest: (module: Module<any, any, any>): ModuleManifest => {
    const ownership: Ownership[] = []
    const owning = owners(module)
    for (const field of Object.keys(module.app.Model.fields)) {
      const claims = owning.flatMap(contract =>
        contract.owns
          .filter(path => path[0] === field)
          .map(path => ({ path, owner: { kind: contract.kind, name: contract.name } })),
      )
      const whole = claims.find(claim => claim.path.length === 1)
      if (whole !== undefined) ownership.push(whole)
      else {
        ownership.push({ path: [field], owner: undefined })
        ownership.push(...claims.sort((a, b) => pathKey(a.path).localeCompare(pathKey(b.path))))
      }
    }
    return {
      fields: Object.keys(module.app.Model.fields),
      messages: applicationTags(module.app),
      ownership,
      contracts: module.contracts.map(({ owner: _owner, ...rest }) => rest),
      findings: Module.validate(module),
    }
  },

  /** The manifest as Markdown: the ownership tree, a table of contracts, and findings. */
  toMarkdown: (module: Module<any, any, any>): string => {
    const manifest = Module.manifest(module)
    const lines: string[] = ['```text', 'Model']
    const width = Math.max(0, ...manifest.ownership.map(row => pathKey(row.path).length))
    manifest.ownership.forEach((row, index) => {
      const last = index === manifest.ownership.length - 1
      const owner =
        row.owner === undefined ? 'LOCAL' : `${row.owner.kind.toUpperCase()} ${row.owner.name}`
      lines.push(`${last ? '└── ' : '├── '}${pathKey(row.path).padEnd(width)}  ${owner}`)
    })
    lines.push(
      '```',
      '',
      '| Contract | Owns | Observes | Messages | Requirements |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const contract of manifest.contracts)
      lines.push(
        `| ${contract.kind}:${contract.name} | ${contract.owns.map(pathKey).join(', ')} | ${contract.observes.map(pathKey).join(', ')} | ${contract.messages.join(', ')} | ${contract.requirements.map(r => `${r.entity}:${r.id}`).join(', ')} |`,
      )
    if (manifest.findings.length > 0) {
      lines.push('', '## Findings', '')
      for (const finding of manifest.findings)
        lines.push(`- **${finding.rule}** ${finding.message}`)
    }
    return lines.join('\n')
  },

  /**
   * The manifest as a Mermaid flowchart: Model fields in a subgraph, one node
   * per contract, a solid edge for ownership and a dotted edge for observation.
   */
  toMermaid: (module: Module<any, any, any>): string => {
    const manifest = Module.manifest(module)
    const lines = ['flowchart LR', '  subgraph Model']
    manifest.fields.forEach((field, index) => lines.push(`    f${index}["${field}"]`))
    lines.push('  end')
    // A path outside the Model (reported by `validate`) draws no edge.
    const fieldId = (path: readonly string[]): string | undefined => {
      const index = path.length === 0 ? -1 : manifest.fields.indexOf(path[0]!)
      return index < 0 ? undefined : `f${index}`
    }
    manifest.contracts.forEach((contract, index) => {
      lines.push(`  c${index}["${contract.kind}:${contract.name}"]`)
      for (const path of contract.owns) {
        const field = fieldId(path)
        if (field !== undefined) lines.push(`  c${index} -->|owns| ${field}`)
      }
      for (const path of contract.observes) {
        const field = fieldId(path)
        if (field !== undefined && !contract.owns.some(owned => pathKey(owned) === pathKey(path)))
          lines.push(`  c${index} -.-> ${field}`)
      }
    })
    return lines.join('\n')
  },
}
