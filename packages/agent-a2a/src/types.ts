import type { Agent } from '@foldkit/agent'

/**
 * The bound contract, with its capability maps left open.
 *
 * An adapter reads names off the wire, so it works against the permissive maps
 * rather than a particular application's.
 */
export type AgentRuntime = Agent.AgentRuntime<any, any, any, any, any>

export type Definition = Agent.Definition<any, any, any, any, any>

/**
 * The JSON-RPC envelope A2A uses.
 *
 * Deliberately a local copy rather than shared with `@foldkit/agent-mcp`: two
 * protocols that happen to use the same envelope should not be coupled through
 * it.
 */
export type Id = string | number

export interface Request {
  readonly jsonrpc: '2.0'
  readonly id: Id
  readonly method: string
  readonly params?: Record<string, unknown> | undefined
}

export interface Success {
  readonly jsonrpc: '2.0'
  readonly id: Id
  readonly result: unknown
}

export interface Failure {
  readonly jsonrpc: '2.0'
  readonly id: Id | null
  readonly error: { readonly code: number; readonly message: string }
}

export type Response = Success | Failure

export const code = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** A2A: the task id is not one this agent issued. */
  TASK_NOT_FOUND: -32001,
} as const

export const success = (id: Id, result: unknown): Success => ({ jsonrpc: '2.0', id, result })

export const failure = (id: Id | null, errorCode: number, message: string): Failure => ({
  jsonrpc: '2.0',
  id,
  error: { code: errorCode, message },
})

/** Terminal states end a task; `working` is the only one that does not. */
export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected'

export interface TaskStatus {
  readonly state: TaskState
  readonly timestamp: string
  /** What happened, in the agent's own words. */
  readonly message?: Message | undefined
}

export interface Part {
  readonly kind: 'text' | 'data'
  readonly text?: string | undefined
  readonly data?: Record<string, unknown> | undefined
}

export interface Message {
  readonly role: 'user' | 'agent'
  readonly parts: ReadonlyArray<Part>
  readonly messageId: string
  readonly taskId?: string | undefined
  readonly contextId?: string | undefined
}

export interface Task {
  readonly id: string
  readonly contextId: string
  readonly status: TaskStatus
  readonly history: ReadonlyArray<Message>
}

export const text = (body: string): Part => ({ kind: 'text', text: body })
