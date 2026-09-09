/** The slice of JSON-RPC 2.0 that MCP uses. */

export type Id = string | number

export interface Request {
  readonly jsonrpc: '2.0'
  readonly id: Id
  readonly method: string
  readonly params?: Record<string, unknown> | undefined
}

export interface Notification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: Record<string, unknown> | undefined
}

export interface Success {
  readonly jsonrpc: '2.0'
  readonly id: Id
  readonly result: Record<string, unknown>
}

export interface Failure {
  readonly jsonrpc: '2.0'
  readonly id: Id | null
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type Response = Success | Failure
export type Incoming = Request | Notification

/**
 * The codes MCP relies on.
 *
 * `INVALID_PARAMS` is the one that carries meaning here: the spec puts an
 * unknown tool and arguments that fail the advertised schema on this side, and
 * everything the application decided -- unavailable, unauthorized, cancelled --
 * in a result with `isError`.
 */
export const code = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Used by MCP for "not initialized" and "resource not found". */
  REQUEST_FAILED: -32002,
} as const

export const success = (id: Id, result: Record<string, unknown>): Success => ({
  jsonrpc: '2.0',
  id,
  result,
})

export const failure = (id: Id | null, errorCode: number, message: string): Failure => ({
  jsonrpc: '2.0',
  id,
  error: { code: errorCode, message },
})

export const isRequest = (message: Incoming): message is Request =>
  typeof (message as Request).id === 'string' || typeof (message as Request).id === 'number'

/** True for a value shaped like a JSON-RPC message this server can act on. */
export const isIncoming = (value: unknown): value is Incoming =>
  typeof value === 'object' &&
  value !== null &&
  (value as Incoming).jsonrpc === '2.0' &&
  typeof (value as Incoming).method === 'string'
