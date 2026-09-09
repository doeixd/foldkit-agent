import { Agent } from '@foldkit/agent'
import type { Definition } from './types.js'

/** Where an A2A client looks for the card. */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json'

/** One thing this agent can do. Derived from an exposed capability. */
export interface AgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
  /** The JSON Schema for this skill's input, as the contract derived it. */
  readonly inputSchema: Record<string, unknown>
}

export interface AgentCard {
  readonly protocolVersion: string
  readonly name: string
  readonly description: string
  /** Where this agent accepts A2A requests. */
  readonly url: string
  readonly version: string
  readonly capabilities: {
    readonly streaming: boolean
    readonly pushNotifications: boolean
  }
  readonly defaultInputModes: ReadonlyArray<string>
  readonly defaultOutputModes: ReadonlyArray<string>
  readonly skills: ReadonlyArray<AgentSkill>
  readonly securitySchemes?: Record<string, unknown> | undefined
  readonly security?: ReadonlyArray<Record<string, ReadonlyArray<string>>> | undefined
}

export const A2A_VERSION = '1.0'

export interface AgentCardOptions {
  readonly name: string
  readonly description: string
  /** The endpoint that answers `message/send`. */
  readonly url: string
  readonly version?: string | undefined
  /** Declared so a client knows how to authenticate before it calls. */
  readonly securitySchemes?: Record<string, unknown> | undefined
  readonly security?: ReadonlyArray<Record<string, ReadonlyArray<string>>> | undefined
}

/**
 * Builds the card an A2A client fetches before calling.
 *
 * Skills are the exposed capabilities: the same descriptors MCP lists as tools.
 * A capability that is only available in some Model states is tagged, because a
 * card is static while availability is not.
 */
export const agentCard = (definition: Definition, options: AgentCardOptions): AgentCard => ({
  protocolVersion: A2A_VERSION,
  name: options.name,
  description: options.description,
  url: options.url,
  version: options.version ?? '0.1.0',
  // Streaming and push notifications are not implemented; saying otherwise
  // would have clients wait for events that never arrive.
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: Agent.messages(definition).map(capability => ({
    id: capability.name,
    name: capability.name,
    description: capability.description,
    tags: [
      ...(capability.modelDependent ? ['conditional'] : []),
      ...(capability.requiresAuthorization ? ['authorized'] : []),
    ],
    inputSchema: capability.inputSchema,
  })),
  ...(options.securitySchemes === undefined ? {} : { securitySchemes: options.securitySchemes }),
  ...(options.security === undefined ? {} : { security: options.security }),
})
