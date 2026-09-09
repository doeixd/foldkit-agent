/**
 * `foldkit-agent-a2a` -- serves a Foldkit agent contract as an A2A agent.
 *
 * One exposed capability is one skill on the Agent Card, and `message/send`
 * dispatches it as a task. The protocol mapping is transport-free, like the MCP
 * adapter's.
 */
export * as AgentA2a from './agentA2a.js'
export type { Message, Part, Response, Task, TaskState, TaskStatus } from './types.js'
