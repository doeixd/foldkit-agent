import { Schema } from 'effect'
import type { Agent } from 'foldkit-agent'

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
 * Deliberately a local copy rather than shared with `foldkit-agent-mcp`: two
 * protocols that happen to use the same envelope should not be coupled through
 * it.
 */
export type Id = string | number

export interface Request {
  readonly jsonrpc: '2.0'
  readonly id: Id
  readonly method: string
  /** Unvalidated until a method decides what its own params must look like. */
  readonly params?: unknown
}

/**
 * The envelope, decoded before anything reads a field off it.
 *
 * `params` stays `unknown` here: what a method requires is the method's
 * business, and deciding it here would answer bad params with the wrong code.
 */
export const RequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
})

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
  /** A2A: the task has already settled, so there is nothing left to cancel. */
  TASK_NOT_CANCELABLE: -32002,
} as const

export const success = (id: Id, result: unknown): Success => ({ jsonrpc: '2.0', id, result })

export const failure = (id: Id | null, errorCode: number, message: string): Failure => ({
  jsonrpc: '2.0',
  id,
  error: { code: errorCode, message },
})

/**
 * The subset of A2A 0.3.0 task states this adapter produces.
 *
 * `input-required`, `auth-required` and `unknown` are spec states no dispatch
 * here can reach, so they are left out rather than declared and never used.
 */
export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'rejected'

/** States a task cannot leave. A later settle must not overwrite one. */
export const terminal: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'canceled',
  'rejected',
])

export interface TaskStatus {
  readonly state: TaskState
  readonly timestamp: string
  /** What happened, in the agent's own words. */
  readonly message?: Message | undefined
}

/**
 * A part carries either text or data, and which one is not optional.
 *
 * A single struct with both fields optional would accept
 * `{ kind: 'data' }` and leave every reader to re-check.
 */
export const PartSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('data'),
    data: Schema.Record(Schema.String, Schema.Unknown),
  }),
])

export type Part = typeof PartSchema.Type

/**
 * `kind` is required by the spec, not decoration: `Task | Message` is a union a
 * client discriminates on, so a message without it is not a Message.
 */
export const MessageSchema = Schema.Struct({
  kind: Schema.Literal('message'),
  role: Schema.Literals(['user', 'agent']),
  parts: Schema.Array(PartSchema),
  messageId: Schema.String,
  taskId: Schema.optional(Schema.String),
  contextId: Schema.optional(Schema.String),
})

export type Message = typeof MessageSchema.Type

/** What `message/send` requires of its params. */
export const SendParamsSchema = Schema.Struct({ message: MessageSchema })

export interface Task {
  readonly kind: 'task'
  readonly id: string
  readonly contextId: string
  readonly status: TaskStatus
  readonly history: ReadonlyArray<Message>
}

export const text = (body: string): Part => ({ kind: 'text', text: body })
