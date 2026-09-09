/**
 * `@foldkit/agent` — a thin, Schema-first agent layer for Foldkit.
 *
 * Project a Foldkit application's Model and Message union into a deliberate,
 * protocol-neutral agent contract:
 *
 * ```text
 * Model         -> Agent.context   (what an agent may see)
 * Message union -> Agent.expose    (what an agent may do)
 * ```
 *
 * Everything else — WebMCP, MCP, in-app agents, A2A — is an adapter over the
 * resulting `Agent.Definition`. `update` remains the single source of truth.
 */
export * as Agent from './agent.js'
