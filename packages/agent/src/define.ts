import type { Context } from './context.js'
import type { ExposedMessages } from './expose.js'
import type { Resource } from './resource.js'

/**
 * The protocol-neutral agent contract for an application.
 *
 * A definition contains no model-provider and no MCP/WebMCP configuration. It
 * describes what an agent may see and what an agent may do; every protocol is
 * an adapter over this value.
 */
export interface Definition<Model = unknown, Context_ = unknown, Principal = unknown> {
  readonly _tag: 'AgentDefinition'
  readonly context?: Context<Model, Context_> | undefined
  readonly messages: ExposedMessages<Model, Principal>
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
export const define = <Model = unknown, Context_ = unknown, Principal = unknown>(options: {
  readonly context?: Context<Model, Context_> | undefined
  readonly messages: ExposedMessages<Model, Principal>
  readonly resources?: ReadonlyArray<Resource<Model, any>> | undefined
}): Definition<Model, Context_, Principal> => {
  const resources = options.resources ?? []

  const names = new Set<string>()
  for (const resource of resources) {
    if (names.has(resource.name)) {
      throw new Error(`Duplicate agent resource name "${resource.name}"`)
    }
    names.add(resource.name)
  }

  return {
    _tag: 'AgentDefinition',
    context: options.context,
    messages: options.messages,
    resources: resources as ReadonlyArray<Resource<Model, unknown>>,
  }
}
