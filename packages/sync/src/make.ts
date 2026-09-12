/**
 * The Foldkit-facing sync layer: `Sync.forApplication(App).make(config)`
 * compiles an application, a writable projection, and a durable Message subset
 * into the low-level `defineSync` contract, and exposes a read-only Surface over
 * the same projection.
 */
import { Schema } from 'effect'
import {
  MessageSet,
  Projection,
  Surface,
  type AppScope,
  type Contract,
  type MergeConstructors,
  type MergeFields,
  type RunnableApplication,
  type WritableProjection,
} from 'foldkit-surface'
import type { DocumentId } from './ids.js'
import { defineSync, type JournalContract, type Operation, type Sync } from './sync.js'

type MessageConstructor<Message> = (...args: never[]) => Message

/** The Message union a tuple of constructors produces. */
export type MsgOf<Ms extends readonly unknown[]> = Ms[number] extends (...args: never[]) => infer M
  ? M
  : never

type AppMessage<
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
> = Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>

/** Reads the tag off a Foldkit Message constructor without constructing one. */
const messageTag = (constructor: unknown): string | undefined => {
  const literal = (constructor as { fields?: { _tag?: { ast?: { literal?: unknown } } } }).fields
    ?._tag?.ast?.literal
  return typeof literal === 'string' ? literal : undefined
}

/** The `_tag` literal of the Message a constructor produces. */
type TagOf<C> = C extends (...args: never[]) => infer M
  ? M extends { readonly _tag: infer T extends string }
    ? T
    : never
  : never

/**
 * A journal contract that also carries the declared authorization policy, in
 * the shape `makeJournal` takes, so `makeJournal({ ...contract })` applies it.
 */
export interface PolicyJournalContract<Operation, Shared, Principal> extends JournalContract<
  Operation,
  Shared
> {
  readonly authorize?: (request: {
    readonly principal: Principal
    readonly operation: Operation
    readonly snapshot: Shared
  }) => boolean
}

/** What a per-variant `authorize` rule sees before the journal commits. */
export interface AuthorizeRequest<Principal, Message, Shared> {
  readonly principal: Principal
  readonly message: Message
  readonly shared: Shared
}

/**
 * Per-variant policy, keyed by durable tag: `message` is that variant exactly,
 * `shared` the authoritative snapshot. A variant without a rule is allowed; the
 * server may still refuse on its own grounds.
 */
export type AuthorizePolicy<
  Principal,
  Fields extends Schema.Struct.Fields,
  Ms extends readonly unknown[],
> = {
  readonly [K in TagOf<Ms[number]>]?: (
    request: AuthorizeRequest<
      Principal,
      Extract<MsgOf<Ms>, { readonly _tag: K }>,
      Schema.Struct.Type<Fields>
    >,
  ) => boolean
}

interface BaseOptions<
  Principal,
  Fields extends Schema.Struct.Fields,
  Ms extends readonly unknown[],
> {
  readonly documentId: DocumentId
  /** Name for the generated `surface`; defaults to the document id. */
  readonly name?: string
  /**
   * Replaces the replay derived from the application's `update`. It is a pure
   * reducer over the shared subset; only durable Messages reach it, and it runs
   * during admission, replay, and optimistic projection. It is not guarded: the
   * author owns its agreement with `update`.
   */
  readonly replay?: (
    shared: Schema.Struct.Type<NoInfer<Fields>>,
    message: MsgOf<NoInfer<Ms>>,
  ) => Schema.Struct.Type<NoInfer<Fields>>
  /** Authorization the server journal applies before committing; see `AuthorizePolicy`. */
  readonly authorize?: AuthorizePolicy<Principal, NoInfer<Fields>, NoInfer<Ms>>
}

export interface MakeOptions<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Subset,
  Ms extends readonly MessageConstructor<any>[],
  Principal = unknown,
> extends BaseOptions<Principal, Fields, Ms> {
  /** The writable projection of the shared fields. */
  readonly shared: WritableProjection<AppModel, Fields>
  /** The Message subset the replica durably records and replays. */
  readonly durable: MessageSet<AppModel, any, Subset, Ms>
}

/**
 * One feature's contribution to a document: the fields it shares and the
 * Messages it records. `compose` merges fragments into one, to spread into
 * `make`; a field declared twice with a different codec or a tag declared twice
 * is rejected there.
 */
export interface SyncFragment<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Subset,
  Ms extends readonly MessageConstructor<any>[],
> {
  readonly shared: WritableProjection<AppModel, Fields>
  readonly durable: MessageSet<AppModel, any, Subset, Ms>
}

type SharedOf<Fs extends readonly SyncFragment<any, any, any, any>[]> = {
  readonly [K in keyof Fs]: Fs[K]['shared']
}
type DurableOf<Fs extends readonly SyncFragment<any, any, any, any>[]> = {
  readonly [K in keyof Fs]: Fs[K]['durable']
}
/** The merged shared fields of several fragments. */
export type FragmentFields<Fs extends readonly SyncFragment<any, any, any, any>[]> = MergeFields<
  SharedOf<Fs>
>
/** The concatenated durable constructors of several fragments. */
export type FragmentConstructors<Fs extends readonly SyncFragment<any, any, any, any>[]> =
  MergeConstructors<DurableOf<Fs>>

/** The union of Messages several fragments record. */
export type FragmentMessages<Fs extends readonly SyncFragment<any, any, any, any>[]> =
  Fs[number] extends SyncFragment<any, any, infer V, any> ? V : never

/**
 * The value `make` returns: the low-level `Sync` protocol plus the writable
 * projection, the declared Messages, and a read-only Surface over the
 * projection. Exported so a consumer can name the type.
 */
export interface DefinedSync<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Message,
  Ms extends readonly unknown[],
  Principal = unknown,
> extends Sync<Message, Schema.Struct.Type<Fields>> {
  readonly surface: Surface<AppModel, Schema.Struct.Type<Fields>, MsgOf<Ms>, void>
  readonly projection: WritableProjection<AppModel, Fields>
  readonly messages: Ms
  /** For `Module`: this contract owns the shared projection's paths and records the durable tags. */
  readonly contract: Contract
  /** The durable journal's codecs, reducer, and, when declared, authorization. */
  readonly journalContract: () => PolicyJournalContract<
    Operation,
    Schema.Struct.Type<Fields>,
    Principal
  >
}

/** The sync constructors specialized to one application. */
export interface ApplicationSync<
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Principal = unknown,
> {
  /**
   * Fixes the `Principal` that `authorize` rules see. A `Principal` cannot be a
   * positional type argument beside an inferred Model, so it is supplied here:
   * `Sync.forApplication(App).withPrincipal<User>()`. Type-only.
   */
  readonly withPrincipal: <P>() => ApplicationSync<AppModel, F, Cases, P>
  /** One feature's shared fields and durable Messages, for `compose`. */
  readonly fragment: <
    Fields extends Schema.Struct.Fields,
    Subset,
    Ms extends readonly MessageConstructor<AppMessage<AppModel, F, Cases>>[],
  >(config: {
    readonly shared: WritableProjection<AppModel, Fields>
    readonly durable: MessageSet<AppModel, any, Subset, Ms>
  }) => SyncFragment<AppModel, Fields, Subset, Ms>
  /**
   * Merges fragments into one: `make({ documentId, ...compose(Todos, Members) })`.
   * A field declared twice with a different codec, a tag declared twice, or a
   * fragment from another application throws.
   */
  readonly compose: <const Fs extends readonly SyncFragment<AppModel, any, any, any>[]>(
    ...fragments: Fs
  ) => SyncFragment<AppModel, FragmentFields<Fs>, FragmentMessages<Fs>, FragmentConstructors<Fs>>
  readonly make: <
    Fields extends Schema.Struct.Fields,
    Subset,
    Ms extends readonly MessageConstructor<AppMessage<AppModel, F, Cases>>[],
  >(
    options: MakeOptions<AppModel, Fields, Subset, Ms, Principal>,
  ) => DefinedSync<AppModel, Fields, AppMessage<AppModel, F, Cases>, Ms, Principal>
}

/**
 * Replay derived from the application's own `update`: install the shared slice
 * into the initial Model, apply the Message, and read the slice back.
 *
 * A durable Message must be a deterministic, state-only transition of the shared
 * projection. Replay refuses one that returns a Command (a live effect cannot be
 * replayed) or that changes a Model field outside the projection (the change
 * would be silently lost), so a Message that needs either stays local and emits
 * a durable fact once the effect settles.
 */
const derivedReplay = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Fields extends Schema.Struct.Fields,
>(
  app: RunnableApplication<AppModel, F, Cases, any>,
  shared: WritableProjection<AppModel, Fields>,
): ((
  value: Schema.Struct.Type<Fields>,
  message: AppMessage<AppModel, F, Cases>,
) => Schema.Struct.Type<Fields>) => {
  const { initial, update } = app
  // Per-field equivalences for the fields the projection does not own outright,
  // built once, so a violation names the fields and replay (which runs per
  // pending operation on every optimistic read) does not re-compare the shared
  // slice against itself. A partially shared field is still compared.
  const owned = new Set(shared.dependencies.filter(path => path.length === 1).map(path => path[0]))
  const fields = Object.entries(app.Model.fields)
    .filter(([key]) => !owned.has(key))
    .map(
      ([key, field]) =>
        [key, Schema.toEquivalence(field as unknown as Schema.Schema<unknown>)] as const,
    )
  return (value, message) => {
    const result = update(shared.set(initial, value), message)
    const tag = (message as { readonly _tag?: string })._tag
    if (result.commands !== undefined && result.commands.length > 0)
      throw new Error(
        `Sync.forApplication: durable "${tag}" returned ${result.commands.length} Command(s); a durable transition is state-only`,
      )
    const next = shared.get(result.model)
    // Writing the projection back into the baseline reproduces `update`'s
    // result exactly when it touched only shared fields.
    const written = shared.set(initial, next) as Record<string, unknown>
    const actual = result.model as Record<string, unknown>
    const changed = fields.filter(([key, equal]) => !equal(actual[key], written[key]))
    if (changed.length > 0)
      throw new Error(
        `Sync.forApplication: durable "${tag}" changed Model fields outside the shared projection: ${changed.map(([key]) => key).join(', ')}`,
      )
    return next
  }
}

/**
 * Merges fragments into one. The primitives reject a conflicting field, a
 * duplicate tag, and a subset from another application.
 */
const composeFragments = (
  fragments: readonly SyncFragment<any, any, any, any>[],
): SyncFragment<any, any, any, any> => {
  const compose = Projection.compose as (
    ...projections: readonly WritableProjection<any, any>[]
  ) => WritableProjection<any, any>
  const union = MessageSet.union as (
    ...subsets: readonly MessageSet<any, any, any, any>[]
  ) => MessageSet<any, any, any, any>
  return {
    shared: compose(...fragments.map(fragment => fragment.shared)),
    durable: union(...fragments.map(fragment => fragment.durable)),
  }
}

/**
 * Specializes the sync constructors to a `Surface.application`, so
 * `Sync.forApplication(App).make({ documentId, shared, durable })` derives the
 * shared codec, the initial snapshot, the durable predicate, and replay from
 * the application, and refuses a subset that belongs to another application.
 * `defineSync` remains the protocol primitive when there is no application to
 * derive from.
 */
export const forApplication = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
>(
  app: RunnableApplication<AppModel, F, Cases, any>,
): ApplicationSync<AppModel, F, Cases> => build(app)

const build = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Principal,
>(
  app: RunnableApplication<AppModel, F, Cases, any>,
): ApplicationSync<AppModel, F, Cases, Principal> => {
  type Message = AppMessage<AppModel, F, Cases>
  const decodeMessage = Schema.decodeUnknownSync(
    app.Message as unknown as Schema.Codec<Message, unknown>,
  )

  const make = (
    options: MakeOptions<AppModel, any, any, any, Principal>,
  ): DefinedSync<AppModel, any, Message, any, Principal> => {
    type Shared = Record<string, unknown>
    const { shared, durable } = options

    // Two applications can have structurally identical Message unions, so the
    // types cannot separate them; the owner token can.
    if (durable.owner !== app.owner)
      throw new Error('Sync.make: the durable subset belongs to a different application')

    const replay: (value: Shared, message: Message) => Shared =
      options.replay === undefined
        ? derivedReplay(app, shared)
        : // `durable` has already rejected anything outside the declared subset.
          (value, message) => options.replay!(value, message as never)
    const durableTags = new Set(
      (durable.constructors as readonly unknown[])
        .map(messageTag)
        .filter((tag): tag is string => tag !== undefined),
    )
    // `AppScope` does not constrain its schemas' services; a Foldkit Message union
    // and a Struct are pure, so the low-level contract's `never` is satisfied.
    const sync = defineSync<Message, Shared, unknown, unknown>({
      documentId: options.documentId,
      message: app.Message as unknown as Schema.Codec<Message, unknown>,
      shared: shared.schema as unknown as Schema.Codec<Shared, unknown>,
      empty: shared.get(app.initial),
      durable: message => {
        const tag = (message as { readonly _tag?: string })._tag
        return tag !== undefined && durableTags.has(tag)
      },
      replay,
    })

    const rules = options.authorize as
      Record<string, (request: AuthorizeRequest<Principal, Message, Shared>) => boolean> | undefined
    const journalContract = (): PolicyJournalContract<Operation, Shared, Principal> => {
      const base = sync.journalContract()
      if (rules === undefined) return base
      return {
        ...base,
        authorize: ({ principal, operation, snapshot }) => {
          const message = decodeMessage(operation.message)
          const rule = rules[(message as { readonly _tag: string })._tag]
          return rule === undefined ? true : rule({ principal, message, shared: snapshot })
        },
      }
    }

    const readOnly: Projection<AppModel, Shared> = {
      Model: shared.schema,
      dependencies: shared.dependencies,
      requirements: [],
      read: shared.get,
    }
    const surface = Surface.make(app, options.name ?? String(options.documentId), {
      model: () => readOnly,
      messages: durable.constructors,
    })
    const contract: Contract = {
      kind: 'sync',
      name: surface.name,
      owner: app.owner,
      owns: shared.dependencies,
      observes: shared.dependencies,
      messages: [...durable.tags],
      requirements: [],
    }
    return {
      ...sync,
      journalContract,
      surface,
      projection: shared,
      messages: durable.constructors,
      contract,
    }
  }

  return {
    withPrincipal: <P>() => build<AppModel, F, Cases, P>(app),
    fragment: config => {
      if (config.durable.owner !== app.owner)
        throw new Error('Sync.fragment: the durable subset belongs to a different application')
      return { shared: config.shared, durable: config.durable }
    },
    compose: ((...fragments: readonly SyncFragment<any, any, any, any>[]) =>
      composeFragments(fragments)) as ApplicationSync<AppModel, F, Cases, Principal>['compose'],
    make: make as ApplicationSync<AppModel, F, Cases, Principal>['make'],
  }
}
