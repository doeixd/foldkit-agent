/**
 * `@foldkit/agent-native` -- PROTOTYPE.
 *
 * Compiles a Foldkit agent contract into Agent Native actions. Foldkit stays the
 * source of truth: a generated action only dispatches, and application
 * behaviour stays in `update`.
 *
 * Not published, and not verified against the framework itself. See the README.
 */
export * as AgentNative from './agentNative.js'
export type { Action, ActionResult, ActionsOptions, DefineAction } from './actions.js'
