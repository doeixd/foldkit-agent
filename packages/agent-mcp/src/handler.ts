import type { Agent } from '@foldkit/agent'
import { Effect } from 'effect'
import {
  type Id,
  type Incoming,
  type Notification,
  type Request,
  type Response,
  code,
  failure,
  isIncoming,
  isRequest,
  success,
} from './jsonRpc.js'

/** The protocol version this handler speaks. */
export const PROTOCOL_VERSION = '2025-06-18'

export interface HandlerOptions<Model, Context_, Principal, ByName, ByTag> {
  readonly agent: Agent.AgentRuntime<Model, Context_, Principal, ByName, ByTag>
  /** Announced in `initialize`. */
  readonly serverInfo?: { readonly name: string; readonly version: string } | undefined
  /** Receives server-initiated notifications, such as `tools/list_changed`. */
  readonly onNotification?: ((notification: Notification) => void) | undefined
  /**
   * Coalesces availability changes before announcing them. A Model that changes
   * often but rarely changes the advertised set needs no delay; one that flaps
   * does.
   */
  readonly debounceMs?: number | undefined
}

export interface Handler {
  /** Handles one message. Resolves to `undefined` for a notification. */
  readonly handle: (message: unknown) => Promise<Response | undefined>
  /** Stops following the Model. */
  readonly close: () => void
}

const textResult = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text', text }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
})

const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

/**
 * Which agent failures are the caller's fault at the protocol level.
 *
 * The spec puts an unknown tool and arguments that fail the advertised schema in
 * a JSON-RPC error, and everything the application decided in a result with
 * `isError`. Reporting an authorization refusal as a protocol error would have
 * clients retry it as a transport fault.
 */
const isProtocolError = (tag: string): boolean =>
  tag === 'AgentUnknownCapabilityError' || tag === 'AgentInvalidInputError'

/**
 * Maps a bound agent contract onto MCP, with no transport attached.
 *
 * Every protocol decision lives here, so it can be tested by handing it
 * messages.
 */
export const handler = <Model, Context_, Principal, ByName, ByTag>(
  options: HandlerOptions<Model, Context_, Principal, ByName, ByTag>,
): Handler => {
  const { agent, onNotification } = options
  const serverInfo = options.serverInfo ?? { name: 'foldkit-agent', version: '0.1.0' }

  let initialized = false
  let closed = false
  /** The advertised set, as last announced. Compared to avoid empty notifications. */
  let advertised: string | undefined
  let pending: ReturnType<typeof setTimeout> | undefined

  /** One controller per in-flight request, so `notifications/cancelled` can reach it. */
  const inFlight = new Map<Id, AbortController>()

  const listTools = async () => {
    const available = await Effect.runPromise(agent.messages.available)
    return available.map(capability => ({
      name: capability.name,
      description: capability.description,
      inputSchema: capability.inputSchema,
    }))
  }

  const announceIfChanged = async (): Promise<void> => {
    if (closed || onNotification === undefined) return

    const digest = JSON.stringify(await listTools())
    if (digest === advertised) return

    const first = advertised === undefined
    advertised = digest
    // Nothing to announce before the client has ever listed them.
    if (!first) onNotification({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  const unsubscribe = agent.subscribe(() => {
    if (options.debounceMs === undefined || options.debounceMs <= 0) {
      void announceIfChanged()
      return
    }
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      void announceIfChanged()
    }, options.debounceMs)
  })

  const callTool = async (id: Id, params: Record<string, unknown>): Promise<Response> => {
    const name = params['name']
    if (typeof name !== 'string') {
      return failure(id, code.INVALID_PARAMS, 'tools/call requires a tool name')
    }

    const controller = new AbortController()
    inFlight.set(id, controller)

    try {
      const outcome = await Effect.runPromise(
        Effect.result(
          agent.messages.dispatchUnknown(name, params['arguments'] ?? {}, {
            transport: 'mcp',
            signal: controller.signal,
          }),
        ),
      )

      if (outcome._tag === 'Failure') {
        const error = outcome.failure
        return isProtocolError(error._tag)
          ? failure(id, code.INVALID_PARAMS, error.message)
          : success(id, toolError(error.message))
      }

      const result = outcome.success
      const completion = result.completion
      const text =
        completion === undefined
          ? `Dispatched ${result.tag}`
          : `${completion.status === 'completed' ? 'Completed' : 'Failed'}: ${completion.message._tag}`

      return success(
        id,
        completion !== undefined && completion.status === 'failed'
          ? toolError(text)
          : textResult(text, {
              capability: result.name,
              tag: result.tag,
              ...(completion === undefined ? {} : { completion: completion.status }),
            }),
      )
    } catch {
      // A defect is not something the caller can act on, and its text may carry
      // application internals.
      return success(id, toolError(`Capability "${name}" failed unexpectedly`))
    } finally {
      inFlight.delete(id)
    }
  }

  const readResource = async (id: Id, params: Record<string, unknown>): Promise<Response> => {
    const uri = params['uri']
    if (typeof uri !== 'string' || !uri.startsWith('app://')) {
      return failure(id, code.INVALID_PARAMS, 'resources/read requires an app:// uri')
    }
    const name = uri.slice('app://'.length)

    if (name === 'context') {
      const context = await Effect.runPromise(agent.context)
      return context === undefined
        ? failure(id, code.REQUEST_FAILED, 'This contract projects no context')
        : success(id, {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(context) }],
          })
    }

    const value = await Effect.runPromise(Effect.result(agent.resources.read(name)))
    return value._tag === 'Failure'
      ? failure(id, code.REQUEST_FAILED, value.failure.message)
      : success(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value.success) }],
        })
  }

  const handleRequest = async (request: Request): Promise<Response> => {
    const { id, method } = request
    const params = request.params ?? {}

    if (method === 'initialize') {
      initialized = true
      const resources =
        agent.definition.resources.length > 0 || agent.definition.context !== undefined
      return success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true }, ...(resources ? { resources: {} } : {}) },
        serverInfo,
      })
    }

    if (!initialized) {
      return failure(id, code.REQUEST_FAILED, 'Received a request before initialize')
    }

    switch (method) {
      case 'ping':
        return success(id, {})

      case 'tools/list': {
        // Everything fits in one page, but a cursor we never issued is a client
        // bug rather than something to ignore.
        if (params['cursor'] !== undefined) {
          return failure(id, code.INVALID_PARAMS, 'Unknown cursor')
        }
        const tools = await listTools()
        advertised = JSON.stringify(tools)
        return success(id, { tools })
      }

      case 'tools/call':
        return callTool(id, params)

      case 'resources/list': {
        const resources = agent.definition.resources.map(resource => ({
          uri: `app://${resource.name}`,
          name: resource.name,
          description: resource.description,
          mimeType: 'application/json',
        }))
        return success(id, {
          resources:
            agent.definition.context === undefined
              ? resources
              : [
                  {
                    uri: 'app://context',
                    name: 'context',
                    description: 'The Model state projected for agents',
                    mimeType: 'application/json',
                  },
                  ...resources,
                ],
        })
      }

      case 'resources/read':
        return readResource(id, params)

      default:
        return failure(id, code.METHOD_NOT_FOUND, `Unknown method: ${method}`)
    }
  }

  const handleNotification = (notification: Notification): void => {
    if (notification.method === 'notifications/cancelled') {
      const requestId = notification.params?.['requestId']
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        inFlight.get(requestId)?.abort()
      }
    }
  }

  return {
    handle: async (message: unknown): Promise<Response | undefined> => {
      if (Array.isArray(message)) {
        // MCP carries one message per payload; a batch is not something to
        // half-answer.
        return failure(null, code.INVALID_REQUEST, 'Batched requests are not supported')
      }
      if (!isIncoming(message)) {
        return failure(null, code.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message')
      }

      const incoming = message as Incoming
      if (!isRequest(incoming)) {
        handleNotification(incoming)
        return undefined
      }
      return handleRequest(incoming)
    },

    close: () => {
      closed = true
      if (pending !== undefined) clearTimeout(pending)
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      unsubscribe()
    },
  }
}
