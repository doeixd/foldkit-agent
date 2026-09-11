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
  readonly model: WritableProjection<AppModel, Fields>
  /** The Message variants the replica durably records and replays. */
  readonly messages: Ms
  /** A pure reducer over the shared subset; only durable Messages reach it. */
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
    config.messages.map(messageTag).filter((tag): tag is string => tag !== undefined),
  )
  // `AppScope` does not constrain its schemas' services; a Foldkit Message union
  // and a Struct are pure, so the low-level contract's `never` is satisfied.
  const sync = defineSync<AppMessage, Shared, unknown, SharedEncoded>({
    documentId: config.documentId,
    message: app.Message as unknown as Schema.Codec<AppMessage, unknown>,
    shared: config.model.schema as unknown as Schema.Codec<Shared, SharedEncoded>,
    empty: config.model.get(config.initial),
    durable: message => {
      const tag = (message as { readonly _tag?: string })._tag
      return tag !== undefined && durableTags.has(tag)
    },
    // `durable` has already rejected anything outside the declared subset.
    replay: (value, message) => config.replay(value, message as MsgOf<Ms>),
  })

  const readOnly: Projection<AppModel, Shared> = {
    Model: config.model.schema,
    dependencies: config.model.dependencies,
    requirements: [],
    read: config.model.get,
  }
  const surface = Surface.define(app, name, {
    model: () => readOnly,
    messages: config.messages,
  })

  return { ...sync, surface, projection: config.model, messages: config.messages }
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
  readonly durable: MessageSubset<AppModel, any, Subset, Ms>
}

/**
 * `Sync.forApplication(App, { documentId, shared, durable })` derives the
 * contract from a `Surface.application`: the initial shared value, the durable
 * predicate, and replay. Replay installs the shared slice into the application's
 * initial Model, applies the Message with the application's own `update`, and
 * reads the shared slice back — the state-only, deterministic subset. Use
 * `Sync.make` or `defineSync` when replay must be custom.
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
  return compile(app, config.name ?? String(config.documentId), {
    documentId: config.documentId,
    initial,
    model: shared,
    messages: config.durable.constructors,
    replay: (value, message) =>
      shared.get(
        update(
          shared.set(initial, value),
          // Only durable Messages reach replay, so the subset is an App Message.
          message as Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>,
        ).model,
      ),
  })
}
