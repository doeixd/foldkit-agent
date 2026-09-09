/**
 * `@foldkit/agent-mcp` -- serves a Foldkit agent contract over MCP.
 *
 * The protocol mapping is a transport-free message handler, so it can be tested
 * by handing it JSON-RPC messages. `stdio` attaches it to a process.
 */
export * as AgentMcp from './agentMcp.js'
export { code as jsonRpcCode } from './jsonRpc.js'
export type { Id, Notification, Request, Response } from './jsonRpc.js'
export type {
  HttpHandler,
  HttpHandlerOptions,
  HttpRequest,
  HttpResponse,
  SseEvent,
  SseStream,
} from './http.js'
export type { HttpAppOptions } from './httpApp.js'
