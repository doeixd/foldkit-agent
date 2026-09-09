/**
 * `foldkit-agent-native` -- PROTOTYPE.
 *
 * Compiles a Foldkit agent contract into a package action registry that
 * `registerPackageActions` accepts. Foldkit stays the source of truth: a
 * generated action only dispatches, and application behaviour stays in
 * `update`.
 *
 * Not published, and only partly verified against the framework. See the
 * README.
 */
export * as AgentNative from './agentNative.js'
export type { ActionEntry, ActionResult, ActionRunContext, ActionsOptions } from './actions.js'
