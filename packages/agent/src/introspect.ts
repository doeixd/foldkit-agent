import type { Schema } from 'effect'
import type { Definition } from './make.js'
import { toJsonSchema } from './jsonSchema.js'
import type { AgentSchema, MessageDescriptor, ResourceDescriptor } from './types.js'

/**
 * Describes every exposed capability as protocol-neutral data.
 *
 * Adapters and tests should depend on these descriptors rather than inspecting
 * application internals.
 */
export const messages = (
  definition: Definition<any, any, any, any, any>,
): ReadonlyArray<MessageDescriptor> =>
  definition.messages.variants.map(variant => ({
    name: variant.name,
    tag: variant.tag,
    description: variant.description,
    inputSchema: variant.inputJsonSchema,
    modelDependent: variant.available !== undefined,
    requiresAuthorization: variant.authorize !== undefined,
    completion: variant.completion,
  }))

/** Describes every read-only resource as protocol-neutral data. */
export const resources = (
  definition: Definition<any, any, any, any, any>,
): ReadonlyArray<ResourceDescriptor> =>
  definition.resources.map(resource => ({
    name: resource.name,
    description: resource.description,
    schema: toJsonSchema(resource.schema),
  }))

/** The JSON Schema of the projected agent context, when the definition declares one. */
export const contextSchema = (
  definition: Definition<any, any, any, any, any>,
): Record<string, unknown> | undefined =>
  definition.context === undefined
    ? undefined
    : toJsonSchema(definition.context.Model as unknown as Schema.Codec<unknown>)

/**
 * The full, data-only description of an agent contract.
 *
 * Because the contract is data, it is inspectable and testable without an LLM.
 */
export const schema = (definition: Definition<any, any, any>): AgentSchema => ({
  messages: messages(definition),
  resources: resources(definition),
  context: contextSchema(definition),
})
