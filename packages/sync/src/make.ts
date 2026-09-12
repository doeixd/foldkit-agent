/**
 * The Foldkit-facing sync layer: `Sync.forApplication(App).make(config)`
 * compiles an application, a writable projection, and a durable Message subset
 * into the low-level `defineSync` contract, and exposes a read-only Surface over
 * the same projection.
 */
import { Schema } from 'effect'
import {
  Surface,
  type AppScope,
  type Contract,
  type MessageSet,
  type Projection,
  type RunnableApplication,
  type WritableProjection,
} from 'foldkit-surface'
import type { DocumentId } from './ids.js'
import { defineSync, type Sync } from './sync.js'

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

export interface MakeOptions<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Subset,
  Ms extends readonly MessageConstructor<any>[],
> {
  readonly documentId: DocumentId
  /** Name for the generated `surface`; defaults to the document id. */
  readonly name?: string
  /** The writable projection of the shared fields. */
  readonly shared: WritableProjection<AppModel, Fields>
  /** The Message subset the replica durably records and replays. */
  readonly durable: MessageSet<AppModel, any, Subset, Ms>
  /**
   * Replaces the replay derived from the application's `update`. It is a pure
   * reducer over the shared subset; only durable Messages reach it, and it runs
   * during admission, replay, and optimistic projection. It is not guarded: the
   * author owns its agreement with `update`.
   */
  readonly replay?: (
    shared: Schema.Struct.Type<Fields>,
    message: MsgOf<Ms>,
  ) => Schema.Struct.Type<Fields>
}

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
> extends Sync<Message, Schema.Struct.Type<Fields>> {
  readonly surface: Surface<AppModel, Schema.Struct.Type<Fields>, MsgOf<Ms>, void>
  readonly projection: WritableProjection<AppModel, Fields>
  readonly messages: Ms
  /** For `Module`: this contract owns the shared projection's paths and records the durable tags. */
  readonly contract: Contract
}

/** The sync constructors specialized to one application. */
export interface ApplicationSync<
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
> {
  readonly make: <
    Fields extends Schema.Struct.Fields,
    Subset,
    Ms extends readonly MessageConstructor<AppMessage<AppModel, F, Cases>>[],
  >(
    config: MakeOptions<AppModel, Fields, Subset, Ms>,
  ) => DefinedSync<AppModel, Fields, AppMessage<AppModel, F, Cases>, Ms>
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
): ApplicationSync<AppModel, F, Cases> => ({
  make: <
    Fields extends Schema.Struct.Fields,
    Subset,
    Ms extends readonly MessageConstructor<AppMessage<AppModel, F, Cases>>[],
  >(
    config: MakeOptions<AppModel, Fields, Subset, Ms>,
  ): DefinedSync<AppModel, Fields, AppMessage<AppModel, F, Cases>, Ms> => {
    type Message = AppMessage<AppModel, F, Cases>
    type Shared = Schema.Struct.Type<Fields>
    type SharedEncoded = Schema.Struct.Encoded<Fields>
    const { shared, durable } = config

    // Two applications can have structurally identical Message unions, so the
    // types cannot separate them; the owner token can.
    if (durable.owner !== app.owner)
      throw new Error('Sync.forApplication: the durable subset belongs to a different application')

    const replay: (value: Shared, message: Message) => Shared =
      config.replay === undefined
        ? derivedReplay(app, shared)
        : // `durable` has already rejected anything outside the declared subset.
          (value, message) => config.replay!(value, message as MsgOf<Ms>)
    const durableTags = new Set(
      durable.constructors.map(messageTag).filter((tag): tag is string => tag !== undefined),
    )
    // `AppScope` does not constrain its schemas' services; a Foldkit Message union
    // and a Struct are pure, so the low-level contract's `never` is satisfied.
    const sync = defineSync<Message, Shared, unknown, SharedEncoded>({
      documentId: config.documentId,
      message: app.Message as unknown as Schema.Codec<Message, unknown>,
      shared: shared.schema as unknown as Schema.Codec<Shared, SharedEncoded>,
      empty: shared.get(app.initial),
      durable: message => {
        const tag = (message as { readonly _tag?: string })._tag
        return tag !== undefined && durableTags.has(tag)
      },
      replay,
    })

    const readOnly: Projection<AppModel, Shared> = {
      Model: shared.schema,
      dependencies: shared.dependencies,
      requirements: [],
      read: shared.get,
    }
    const surface = Surface.make(app, config.name ?? String(config.documentId), {
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
    return { ...sync, surface, projection: shared, messages: durable.constructors, contract }
  },
})
