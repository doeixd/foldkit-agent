import type { Context } from './context.js'
import type { AnyCapabilities, ExposedMessages } from './expose.js'
import type { Resource } from './resource.js'

/**
 * The protocol-neutral agent contract for an application.
 *
 * A definition contains no model-provider and no MCP/WebMCP configuration. It
 * describes what an agent may see and what an agent may do; every protocol is
 * an adapter over this value.
 */
export interface Definition<
  Model = unknown,
  Context_ = unknown,
  Principal = unknown,
  ByName = AnyCapabilities,
  ByTag = AnyCapabilities,
> {
  readonly context?: Context<Model, Context_> | undefined
  readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
  readonly resources: ReadonlyArray<Resource<Model, unknown>>
}

/**
 * Combines a context projection, exposed Messages, and optional resources into
 * one agent contract.
 *
 * @example
 * ```ts
 * const AppAgent = Agent.define({ context, messages })
 * ```
 */
export interface DefineOptions<
  Model,
  Context_,
  Principal,
  ByName = AnyCapabilities,
  ByTag = AnyCapabilities,
> {
  readonly context?: Context<Model, Context_> | undefined
  readonly messages: ExposedMessages<Model, Principal, ByName, ByTag>
  readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
}

export const define = <
  Model = unknown,
  Context_ = unknown,
  Principal = unknown,
  ByName = AnyCapabilities,
  ByTag = AnyCapabilities,
>(
  options: DefineOptions<Model, Context_, Principal, ByName, ByTag>,
): Definition<Model, Context_, Principal, ByName, ByTag> => {
  // Copied so a later mutation of the caller's array cannot change the contract.
  const resources = [...(options.resources ?? [])]

  const names = new Set<string>()
  for (const resource of resources) {
    if (names.has(resource.name)) {
      throw new Error(`Duplicate agent resource name "${resource.name}"`)
    }
    names.add(resource.name)
  }

  return {
    context: options.context,
    messages: options.messages,
    resources: resources as ReadonlyArray<Resource<Model, unknown>>,
  }
}
