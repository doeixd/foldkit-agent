import { Schema } from 'effect'
import type { MessageUnion } from 'foldkit/message'
import { toJsonSchema } from './jsonSchema.js'
import { type SnakeCase, assertValidName, defaultName } from './naming.js'
import type { AnyMessage, Completion, InvocationContext, VariantConfig } from './types.js'

type Fields = Schema.Struct.Fields

/** The variant-name-to-fields map a `defineMessageUnion` was declared with. */
export type Cases = Record<string, Fields>

/**
 * The callable constructor for one variant of a Message union.
 *
 * Extracted with `infer` rather than `Parameters<...>` of an intersection: an
 * intersection with `(input: any) => AnyMessage` resolves to that last
 * signature and silently widens every payload to `any`.
 */
type ConstructorFor<C extends Cases, Tag extends keyof C & string> = MessageUnion<C>[Tag]

/** The payload an internal Message constructor accepts, e.g. `{ id: string }`. */
export type MessageInputOf<C extends Cases, Tag extends keyof C & string> =
  ConstructorFor<C, Tag> extends (value: infer Input) => any ? Input : never

/**
 * A variant that exposes its internal Message payload directly.
 *
 * `authorize` is pinned to the same signature as the mapped variant's. The two
 * members are otherwise indistinguishable to contextual typing, and a callback
 * parameter that differs between them cannot be inferred at the call site.
 */
type DirectVariant<MessageInput, Model, Principal> = VariantConfig<
  MessageInput,
  any,
  Model,
  Principal
> & {
  readonly input?: undefined
  readonly toMessage?: undefined
}

/** A variant that maps a distinct external input onto its internal Message. */
type MappedVariant<MessageInput, ExternalInput, Model, Principal> = VariantConfig<
  MessageInput,
  ExternalInput,
  Model,
  Principal
> & {
  readonly input: Schema.Codec<ExternalInput, any, never, never>
  readonly toMessage: (
    input: ExternalInput,
    context: InvocationContext<Model, Principal>,
  ) => MessageInput
}

/**
 * Constrains each key of the supplied variants object.
 *
 * Keys must be tags of the union. A variant is a bare description string, or
 * exposes its Message payload directly, or supplies both `input` and
 * `toMessage`; an object with `input` alone matches no member and is rejected.
 *
 * This is a union rather than a conditional on `V[Tag]`, because a conditional
 * would be circular inside a reverse mapped type and would silently collapse to
 * the direct branch.
 */
export type ValidateVariants<C extends Cases, Model, Principal> = {
  readonly [Tag in keyof C & string]?:
    | DirectVariant<MessageInputOf<C, Tag>, Model, Principal>
    | MappedVariant<MessageInputOf<C, Tag>, any, Model, Principal>
    | string
}

/** The tags of the union that this variants object exposes. */
type ExposedTags<C extends Cases, V> = Extract<keyof V, keyof C & string>

/** What an agent supplies for a variant: its external input, or the Message payload. */
type ExternalInputFor<C extends Cases, V, Tag extends keyof C & string> = V[Tag &
  keyof V] extends { readonly input: Schema.Codec<infer External, any, any, any> }
  ? External
  : MessageInputOf<C, Tag>

/** The protocol-facing name of a variant: its override, or the normalized tag. */
type NameFor<Config, Tag extends string> = Config extends { readonly name: infer Name extends string }
  ? Name
  : SnakeCase<Tag>

/** Capability input types keyed by protocol name, for dispatching by name. */
export type CapabilitiesByName<C extends Cases, V> = {
  readonly [Tag in ExposedTags<C, V> as NameFor<V[Tag], Tag>]: ExternalInputFor<C, V, Tag>
}

/** Capability input types keyed by Message tag, for dispatching by constructor. */
export type CapabilitiesByTag<C extends Cases, V> = {
  readonly [Tag in ExposedTags<C, V>]: ExternalInputFor<C, V, Tag>
}

/** The default maps: any name, unknown input. Adapters work against these. */
export type AnyCapabilities = Record<string, unknown>

/** One compiled capability: everything an adapter needs, and nothing application-specific. */
export interface ExposedVariant<Model = unknown, Principal = unknown> {
  readonly tag: string
  readonly name: string
  readonly description: string
  /** The Effect Schema agent input crosses before dispatch. */
  readonly inputSchema: Schema.Codec<any, any, never, never>
  /** JSON Schema derived from `inputSchema`. */
  readonly inputJsonSchema: Record<string, unknown>
  /** Constructs the internal Foldkit Message. */
  readonly construct: (input: unknown, context: InvocationContext<Model, Principal>) => AnyMessage
  /** The union's own constructor, so a caller can name this capability by reference. */
  readonly messageConstructor: unknown
  readonly available?: ((model: Model) => boolean) | undefined
  readonly authorize?: VariantConfig<any, any, Model, Principal>['authorize']
  readonly completion?: Completion | undefined
}

/**
 * An agent-safe projection of a Foldkit Message union.
 *
 * `ByName` and `ByTag` carry each capability's input type, so dispatching by
 * name or by Message constructor stays checked. They default to the permissive
 * maps, which is what a protocol adapter binds against.
 */
export interface ExposedMessages<
  Model = unknown,
  Principal = unknown,
  ByName = AnyCapabilities,
  ByTag = AnyCapabilities,
> {
  readonly variants: ReadonlyArray<ExposedVariant<Model, Principal>>
  /** Type-only witnesses. Never populated at runtime. */
  readonly '~capabilities'?: { readonly byName: ByName; readonly byTag: ByTag }
}

/**
 * The schema for a capability that takes no input.
 *
 * `Schema.Struct({})` is not an empty-object schema: it accepts `{ foo: 1 }`,
 * `[]`, and `"str"` alike, even with `onExcessProperty: 'error'`. A record with
 * no permitted values accepts `{}` and nothing else, which is what the derived
 * JSON Schema advertises.
 */
const EmptyPayload = Schema.Record(Schema.String, Schema.Never)

/** True for a struct Schema with no fields, whose JSON Schema needs normalizing. */
const isEmptyStruct = (schema: unknown): boolean => {
  const fields = (schema as { fields?: Record<string, unknown> }).fields
  return fields !== undefined && Object.keys(fields).length === 0
}

/** Strips the `_tag` literal so only the agent-facing payload fields remain. */
const payloadSchemaOf = (
  constructor: unknown,
): { schema: Schema.Codec<any, any, never, never>; empty: boolean } => {
  const fields = (constructor as { fields?: Fields }).fields ?? {}
  const payload: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    if (key !== '_tag') payload[key] = (fields as Record<string, unknown>)[key]
  }
  const empty = Object.keys(payload).length === 0
  return {
    schema: empty ? EmptyPayload : (Schema.Struct(payload as Fields) as never),
    empty,
  }
}

/**
 * Creates an agent-safe projection of a Foldkit Message union.
 *
 * Exposure is explicit and opt-in: it declares that a Message variant is
 * meaningful and safe for an agent to originate. There is deliberately no
 * `exposeAll()` — exposure is a capability boundary.
 *
 * A variant that needs nothing but a description can be written as one.
 *
 * @example
 * ```ts
 * const messages = Agent.expose(Message, {
 *   RequestedCreateTodo: 'Create a todo',
 *   RequestedDeleteTodo: {
 *     name: 'delete_todo',
 *     description: 'Delete a todo',
 *     available: model => Option.isSome(model.selectedTodoId),
 *   },
 * })
 * ```
 */
export const expose = <
  const C extends Cases,
  const V extends ValidateVariants<C, Model, Principal>,
  Model = any,
  Principal = any,
>(
  message: MessageUnion<C>,
  variants: V,
): ExposedMessages<Model, Principal, CapabilitiesByName<C, V>, CapabilitiesByTag<C, V>> => {
  const union = message as unknown as Record<string, unknown>

  const compiled = Object.keys(variants).map((tag): ExposedVariant<Model, Principal> => {
    const declared = (variants as Record<string, string | VariantConfig<any, any, Model, Principal>>)[
      tag
    ]!
    // A bare string is the description; every other field takes its default.
    const config: VariantConfig<any, any, Model, Principal> =
      typeof declared === 'string' ? { description: declared } : declared
    const constructor = union[tag]

    if (typeof constructor !== 'function') {
      throw new Error(`Cannot expose "${tag}": it is not a variant of this Message union`)
    }
    if (config.input !== undefined && config.toMessage === undefined) {
      throw new Error(`Cannot expose "${tag}": "input" was provided without "toMessage"`)
    }

    const name = config.name ?? defaultName(tag)
    assertValidName(name, tag)

    const payload = payloadSchemaOf(constructor)
    const external = config.input
    // An externally declared empty struct has the same hole, and the JSON
    // Schema derived for it makes the same promise, so enforce it the same way.
    const externalIsEmpty = external !== undefined && isEmptyStruct(external)
    const inputSchema = (
      external === undefined ? payload.schema : externalIsEmpty ? EmptyPayload : external
    ) as Schema.Codec<any, any, never, never>

    const make = constructor as (value: unknown) => AnyMessage
    const toMessage = config.toMessage
    const construct = (input: unknown, context: InvocationContext<Model, Principal>): AnyMessage =>
      toMessage === undefined ? make(input) : make(toMessage(input, context))

    return {
      tag,
      name,
      description: config.description,
      inputSchema,
      inputJsonSchema: toJsonSchema(inputSchema, {
        emptyPayload: external === undefined ? payload.empty : externalIsEmpty,
      }),
      construct,
      messageConstructor: constructor,
      available: config.available,
      authorize: config.authorize,
      completion: config.completion,
    }
  })

  const names = new Set<string>()
  for (const variant of compiled) {
    if (names.has(variant.name)) {
      throw new Error(`Duplicate exposed capability name "${variant.name}"`)
    }
    names.add(variant.name)
  }

  return { variants: compiled }
}
