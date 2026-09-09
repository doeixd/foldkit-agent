import { Schema } from 'effect'
import type { MessageUnion } from 'foldkit/message'
import { toJsonSchema } from './jsonSchema.js'
import { type CompiledCompletion, compileCompletion } from './completion.js'
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
 * `authorize` is pinned to the same request type as the mapped variant's. The
 * two members are otherwise indistinguishable to contextual typing, and a
 * callback parameter that differs between them makes `principal`, `model` and
 * `transport` uninferable at the call site. `input` is the field that pays for
 * that; `Agent.variant` types it where it matters.
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

/**
 * What an agent puts on the wire for a variant.
 *
 * Dispatch decodes, so this is the schema's **encoded** side, not its decoded
 * one. A payload of `Schema.NumberFromString` is sent as a string and reaches
 * `update` as a number; typing the call site with the decoded type would reject
 * the input that actually works.
 */
type ExternalInputFor<C extends Cases, V, Tag extends keyof C & string> = V[Tag & keyof V] extends {
  readonly input: Schema.Codec<any, infer Encoded, any, any>
}
  ? Encoded
  : Schema.Struct.Encoded<C[Tag]>

/** The protocol-facing name of a variant: its override, or the normalized tag. */
type NameFor<Config, Tag extends string> = Config extends {
  readonly name: infer Name extends string
}
  ? Name
  : SnakeCase<Tag>

/** Capability input types keyed by protocol name, for dispatching by name. */
export type CapabilitiesByName<C extends Cases, V> = {
  readonly [Tag in ExposedTags<C, V> as NameFor<V[Tag], Tag>]: ExternalInputFor<C, V, Tag>
}

/**
 * Capability types keyed by Message tag.
 *
 * Each entry carries the agent-facing input and the Message the capability
 * constructs, so a host can be required to accept what the contract produces.
 */
export type CapabilitiesByTag<C extends Cases, V> = {
  readonly [Tag in ExposedTags<C, V>]: {
    readonly input: ExternalInputFor<C, V, Tag>
    readonly message: MessageFor<C, Tag>
  }
}

/** The Message a capability constructs. */
type MessageFor<C extends Cases, Tag extends keyof C & string> =
  ConstructorFor<C, Tag> extends (value: any) => infer Message ? Message : AnyMessage

/** The default name map: any name, unknown input. Adapters work against this. */
export type AnyCapabilitiesByName = Record<string, unknown>

/** The default tag map: any tag, unknown input, any Message. */
export type AnyCapabilitiesByTag = Record<
  string,
  { readonly input: unknown; readonly message: AnyMessage }
>

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
  /** The completion contract compiled to the tags and predicate the runtime matches on. */
  readonly compiledCompletion?: CompiledCompletion | undefined
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
  ByName = AnyCapabilitiesByName,
  ByTag = AnyCapabilitiesByTag,
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

/**
 * Types a variant that maps a distinct external input onto its Message.
 *
 * Written inline, `toMessage` and `authorize` receive `any`: their input comes
 * from the `input` codec beside them, which TypeScript has not finished
 * inferring while it types the object. Passing the config through a generic
 * function infers it first, so the callbacks are checked.
 *
 * @example
 * ```ts
 * Agent.expose(Message, {
 *   RequestedDeleteTodo: Agent.variant({
 *     description: 'Delete a todo',
 *     input: Schema.Struct({ id: Schema.String }),
 *     toMessage: ({ id }, { invocation }) => ({ id, requestId: invocation.id }),
 *   }),
 * })
 * ```
 */
export const variant = <ExternalInput, MessageInput, Model = any, Principal = any>(config: {
  readonly name?: string | undefined
  readonly description: string
  readonly available?: ((model: Model) => boolean) | undefined
  readonly input: Schema.Codec<ExternalInput, any, never, never>
  readonly toMessage: (
    input: ExternalInput,
    context: InvocationContext<Model, Principal>,
  ) => MessageInput
  readonly authorize?: VariantConfig<MessageInput, ExternalInput, Model, Principal>['authorize']
  readonly completion?: Completion | undefined
}): typeof config => config

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
    const declared = (
      variants as Record<string, string | VariantConfig<any, any, Model, Principal>>
    )[tag]!
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
      ...(config.completion === undefined
        ? {}
        : { compiledCompletion: compileCompletion(config.completion, name) }),
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
