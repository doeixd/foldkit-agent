/**
 * The Foldkit-facing sync layer: compiles an application, a writable projection,
 * a durable Message subset, and a pure `replay` into the low-level `defineSync`
 * contract, and exposes a read-only Surface over the same projection.
 */
import { Schema } from 'effect'
import { Surface, type AppScope, type Projection } from 'foldkit-surface'
import type { DocumentId } from './ids.js'
import type { WritableProjection } from './project.js'
import { defineSync, type Sync } from './sync.js'

type MessageOf<App> = App extends { readonly Message: Schema.Schema<infer M> } ? M : never

type MessageConstructor<Message> = (...args: never[]) => Message

type MsgOf<Ms extends readonly unknown[]> = {
  readonly [K in keyof Ms]: Ms[K] extends (...args: never[]) => infer M ? M : never
}[number]

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
 * `Sync.make(App, name, config)` returns the low-level `Sync` contract plus the
 * projection, the declared Messages, and a read-only `surface` that observes and
 * writes the projection.
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
): Sync<Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>, Schema.Struct.Type<Fields>> & {
  readonly surface: Surface<AppModel, Schema.Struct.Type<Fields>, MsgOf<Ms>, void>
  readonly projection: WritableProjection<AppModel, Fields>
  readonly messages: Ms
} => {
  type AppMessage = Schema.Schema.Type<AppScope<AppModel, F, Cases>['Message']>
  type Shared = Schema.Struct.Type<Fields>

  const durableTags = new Set(
    config.messages.map(messageTag).filter((tag): tag is string => tag !== undefined),
  )
  // `AppScope` does not constrain its schemas' services; a Foldkit Message union
  // and a Struct are pure, so the low-level contract's `never` is satisfied.
  const sync = defineSync<AppMessage, Shared, unknown, unknown>({
    documentId: config.documentId,
    message: app.Message as unknown as Schema.Codec<AppMessage, unknown>,
    shared: config.model.schema as unknown as Schema.Codec<Shared, unknown>,
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
