/**
 * `@foldkit/agent-webmcp` -- the browser-native adapter for `@foldkit/agent`.
 *
 * WebMCP runs in the page itself, so an exposed Message becomes a tool whose
 * `execute` dispatches directly into the same live Foldkit Runtime the human is
 * already using. No DOM automation, and no external browser-session bridge.
 */
export * as AgentWebMcp from './agentWebMcp.js'
export type { ModelContext, ToolDescriptor, ToolExecutionContext, ToolResult } from './webmcp.js'
