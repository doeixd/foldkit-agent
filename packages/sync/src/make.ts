/**
 * The Foldkit-facing sync layer: compiles an application, a writable projection,
 * a durable Message subset, and a pure `replay` into the low-level `defineSync`
 * contract, and exposes a read-only Surface over the same projection.
 */
import { Schema } from 'effect'
import {
  Surface,
  type AppScope,
  type MessageSubset,
  type Projection,
  type RunnableApplication,
} from 'foldkit-surface'
import type { DocumentId } from './ids.js'
import type { WritableProjection } from './project.js'
import { defineSync, type Sync } from './sync.js'

type MessageConstructor<Message> = (...args: never[]) => Message

/** The Message union a tuple of constructors produces. */
export type MsgOf<Ms extends readonly unknown[]> = Ms[number] extends (...args: never[]) => infer M
  ? M
  : never

/** Reads the tag off a Foldkit Message constructor without constructing one. */
const messageTag = (constructor: unknown): string | undefined => {
  const literal = (constructor as { fields?: { _tag?: { ast?: { literal?: unknown } } } }).fields
    ?._tag?.ast?.literal
  return typeof literal === 'string' ? literal : undefined
}

export interface SyncConfig<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Ms extends readonly MessageConstructor<any>[],
> {
  readonly documentId: DocumentId
  /** The Model the projection reads its initial shared value from. */
  readonly initial: AppModel
  /** The writable projection of the shared fields. */
  readonly shared: WritableProjection<AppModel, Fields>
  /** The Message variants the replica durably records and replays. */
  readonly durable: Ms
  /**
   * A pure reducer over the shared subset; only durable Messages reach it. It
   * runs during replay and optimistic projection, so their Commands are dropped;
   * each replay starts from `initial`, so cost tracks the Model.
   */
  readonly replay: (
    shared: Schema.Struct.Type<Fields>,
    message: MsgOf<Ms>,
  ) => Schema.Struct.Type<Fields>
}

/**
 * The value `Sync.make` returns: the low-level `Sync` protocol plus the writable
 * projection, the declared Messages, and a read-only Surface over the projection.
 * Exported so a consumer can name the type.
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
}

/**
 * Compiles a contract into `defineSync` plus a read-only Surface. Shared by
 * `make` (explicit config) and `forApplication` (derived config).
 */
const compile = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Fields extends Schema.Struct.Fields,
  const Ms extends readonly MessageConstructor<
    Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>
  >[],
>(
  app: AppScope<AppModel, F, Cases>,
  name: string,
  config: SyncConfig<AppModel, Fields, Ms>,
): DefinedSync<
  AppModel,
  Fields,
  Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>,
  Ms
> => {
  type AppMessage = Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>
  type Shared = Schema.Struct.Type<Fields>
  type SharedEncoded = Schema.Struct.Encoded<Fields>

  const durableTags = new Set(
    config.durable.map(messageTag).filter((tag): tag is string => tag !== undefined),
  )
  // `AppScope` does not constrain its schemas' services; a Foldkit Message union
  // and a Struct are pure, so the low-level contract's `never` is satisfied.
  const sync = defineSync<AppMessage, Shared, unknown, SharedEncoded>({
    documentId: config.documentId,
    message: app.Message as unknown as Schema.Codec<AppMessage, unknown>,
    shared: config.shared.schema as unknown as Schema.Codec<Shared, SharedEncoded>,
    empty: config.shared.get(config.initial),
    durable: message => {
      const tag = (message as { readonly _tag?: string })._tag
      return tag !== undefined && durableTags.has(tag)
    },
    // `durable` has already rejected anything outside the declared subset.
    replay: (value, message) => config.replay(value, message as MsgOf<Ms>),
  })

  const readOnly: Projection<AppModel, Shared> = {
    Model: config.shared.schema,
    dependencies: config.shared.dependencies,
    requirements: [],
    read: config.shared.get,
  }
  const surface = Surface.define(app, name, {
    model: () => readOnly,
    messages: config.durable,
  })

  return { ...sync, surface, projection: config.shared, messages: config.durable }
}

/**
 * `Sync.make(App, name, config)` compiles an explicit contract: a writable
 * projection, the durable Message constructors, the initial Model, and a pure
 * replay function.
 */
export const make = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Fields extends Schema.Struct.Fields,
  const Ms extends readonly MessageConstructor<
    Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>
  >[],
>(
  app: AppScope<AppModel, F, Cases>,
  name: string,
  config: SyncConfig<AppModel, Fields, Ms>,
): DefinedSync<AppModel, Fields, Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>, Ms> =>
  compile(app, name, config)

export interface ForApplicationConfig<
  AppModel,
  Fields extends Schema.Struct.Fields,
  Subset,
  Ms extends readonly MessageConstructor<any>[],
> {
  readonly documentId: DocumentId
  /** Name for the generated `surface`; defaults to the document id. */
  readonly name?: string
  readonly shared: WritableProjection<AppModel, Fields>
  /** The Message subset the replica durably records and replays. */
  readonly durable: MessageSubset<AppModel, any, Subset, Ms>
}

/**
 * `Sync.forApplication(App, { documentId, shared, durable })` derives the
 * contract from a `Surface.application`: the initial shared value, the durable
 * predicate, and replay. Replay installs the shared slice into the application's
 * initial Model, applies the Message with the application's own `update`, and
 * reads the shared slice back.
 *
 * A durable Message must be a deterministic, state-only transition of the shared
 * projection. Replay refuses one that returns a Command (a live effect cannot be
 * replayed) or that changes a Model field outside the projection (the change
 * would be silently lost), so a Message that needs either stays local and emits
 * a durable fact once the effect settles. Use `Sync.make` or `defineSync` when
 * replay must be custom.
 */
export const forApplication = <
  AppModel,
  F extends Schema.Struct.Fields,
  Cases extends Record<string, Schema.Struct.Fields>,
  Fields extends Schema.Struct.Fields,
  Subset,
  const Ms extends readonly MessageConstructor<
    Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>
  >[],
>(
  app: RunnableApplication<AppModel, F, Cases, any>,
  config: ForApplicationConfig<AppModel, Fields, Subset, Ms>,
): DefinedSync<
  AppModel,
  Fields,
  Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>,
  Ms
> => {
  const { shared } = config
  const { initial, update } = app
  // Two applications can have structurally identical Message unions, so the
  // types cannot separate them; the owner token can.
  if (config.durable.owner !== app.owner)
    throw new Error('Sync.forApplication: the durable subset belongs to a different application')
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
  return compile(app, config.name ?? String(config.documentId), {
    documentId: config.documentId,
    initial,
    shared,
    durable: config.durable.constructors,
    replay: (value, message) => {
      // Only durable Messages reach replay, so the subset is an App Message.
      const result = update(
        shared.set(initial, value),
        message as Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>,
      )
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
    },
  })
}
