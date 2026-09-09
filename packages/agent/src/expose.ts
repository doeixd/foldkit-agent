import { Schema } from 'effect'
import type { MessageUnion } from 'foldkit/message'
import { toJsonSchema } from './jsonSchema.js'
import { defaultName } from './naming.js'
import type { AnyMessage, Completion, InvocationContext, VariantConfig } from './types.js'

type Fields = Schema.Struct.Fields
type Cases = Record<string, Fields>

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

/** The Message value a constructor produces, e.g. `{ _tag: 'RequestedDeleteTodo', id: string }`. */
export type MessageOf<C extends Cases, Tag extends keyof C & string> =
  ConstructorFor<C, Tag> extends (value: any) => infer Message ? Message : never

/** A variant that exposes its internal Message payload directly. */
type DirectVariant<MessageInput, Model, Principal> = VariantConfig<
  MessageInput,
  MessageInput,
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
 * Keys must be tags of the union. A variant either exposes its Message payload
 * directly, or supplies both `input` and `toMessage`; an object with `input`
 * alone matches neither member and is rejected.
 *
 * This is a union rather than a conditional on `V[Tag]`, because a conditional
 * would be circular inside a reverse mapped type and would silently collapse to
 * the direct branch.
 */
type ValidateVariants<C extends Cases, V, Model, Principal> = {
  readonly [Tag in keyof V]: Tag extends keyof C & string
    ?
        | DirectVariant<MessageInputOf<C, Tag>, Model, Principal>
        | MappedVariant<MessageInputOf<C, Tag>, any, Model, Principal>
    : Readonly<{ 'Not a tag of this Message union': Tag }>
}

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
  readonly available?: ((model: Model) => boolean) | undefined
  readonly authorize?: VariantConfig<any, any, Model, Principal>['authorize']
  readonly completion?: Completion | undefined
}

/** An agent-safe projection of a Foldkit Message union. */
export interface ExposedMessages<Model = unknown, Principal = unknown> {
  readonly _tag: 'AgentExposedMessages'
  readonly variants: ReadonlyArray<ExposedVariant<Model, Principal>>
}

/** Strips the `_tag` literal so only the agent-facing payload fields remain. */
const payloadSchemaOf = (constructor: unknown): { schema: Schema.Struct<Fields>; empty: boolean } => {
  const fields = (constructor as { fields?: Fields }).fields ?? {}
  const payload: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    if (key !== '_tag') payload[key] = (fields as Record<string, unknown>)[key]
  }
  return {
    schema: Schema.Struct(payload as Fields),
    empty: Object.keys(payload).length === 0,
  }
}

/**
 * Creates an agent-safe projection of a Foldkit Message union.
 *
 * Exposure is explicit and opt-in: it declares that a Message variant is
 * meaningful and safe for an agent to originate. There is deliberately no
 * `exposeAll()` — exposure is a capability boundary.
 *
 * @example
 * ```ts
 * const messages = Agent.expose(Message, {
 *   RequestedCreateTodo: { name: 'create_todo', description: 'Create a todo' },
 *   RequestedDeleteTodo: { name: 'delete_todo', description: 'Delete a todo' },
 * })
 * ```
 */
export const expose = <
  const C extends Cases,
  const V extends { readonly [Tag in keyof V]: unknown },
  Model = any,
  Principal = any,
>(
  message: MessageUnion<C>,
  variants: ValidateVariants<C, V, Model, Principal>,
): ExposedMessages<Model, Principal> => {
  const union = message as unknown as Record<string, unknown>

  const compiled = Object.keys(variants).map((tag): ExposedVariant<Model, Principal> => {
    const config = (variants as Record<string, VariantConfig<any, any, Model, Principal>>)[tag]!
    const constructor = union[tag]

    if (typeof constructor !== 'function') {
      throw new Error(`Cannot expose "${tag}": it is not a variant of this Message union`)
    }
    if (config.input !== undefined && config.toMessage === undefined) {
      throw new Error(`Cannot expose "${tag}": "input" was provided without "toMessage"`)
    }

    const payload = payloadSchemaOf(constructor)
    const external = config.input
    const inputSchema = (external ?? payload.schema) as Schema.Codec<any, any, never, never>

    const toMessage = config.toMessage
    const construct = (input: unknown, context: InvocationContext<Model, Principal>): AnyMessage =>
      toMessage === undefined
        ? (constructor as (value: unknown) => AnyMessage)(input)
        : ((constructor as (value: unknown) => AnyMessage)(toMessage(input, context)) as AnyMessage)

    return {
      tag,
      name: config.name ?? defaultName(tag),
      description: config.description,
      inputSchema,
      inputJsonSchema: toJsonSchema(inputSchema, {
        emptyStructIsObject: external === undefined && payload.empty,
      }),
      construct,
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

  return { _tag: 'AgentExposedMessages', variants: compiled }
}
