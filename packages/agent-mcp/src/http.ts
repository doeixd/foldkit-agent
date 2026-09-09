import type { Agent } from '@foldkit/agent'
import { type Handler, PROTOCOL_VERSION, handler } from './handler.js'
import { type Notification, code, failure, isIncoming, isRequest } from './jsonRpc.js'

/**
 * The body of a POST whose JSON text could not be parsed.
 *
 * A transport passes this instead of the parsed value so the handler can answer
 * with -32700 rather than the -32600 an absent body earns.
 */
export const UNPARSEABLE_BODY: unique symbol = Symbol.for('@foldkit/agent-mcp/UnparseableBody')

/** A transport-neutral request, so this can sit behind any HTTP server. */
export interface HttpRequest {
  readonly method: string
  /** Header names lowercased. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** The parsed JSON body, for POST, or `UNPARSEABLE_BODY` if it was not JSON. */
  readonly body?: unknown
}

/** One server-sent event. `id` is the cursor a client resumes from. */
export interface SseEvent {
  readonly id: string
  readonly data: string
}

/** An open SSE stream. */
export interface SseStream {
  /** Replayed immediately on subscribe, when the client resumed. */
  readonly backlog: ReadonlyArray<SseEvent>
  /**
   * Attaches the transport to the session, returning an unsubscribe.
   *
   * `end` is called at most once, when the session is terminated -- by DELETE,
   * by idle expiry, or by server close -- and the transport must close the
   * response body when it is. A session already terminated by the time the
   * transport subscribes calls `end` immediately, so the window between opening
   * the response and reading it cannot leave a stream open forever. It is
   * optional only because a transport that has no way to close its response can
   * do nothing with it; one that omits it keeps the response open until the
   * client itself disconnects.
   */
  readonly subscribe: (send: (event: SseEvent) => void, end?: () => void) => () => void
}

export interface HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Present when the response is an SSE stream rather than a JSON body. */
  readonly stream?: SseStream
}

export interface HttpHandlerOptions<Model, Context_, Principal, ByName, ByTag> {
  /**
   * Binds a runtime for one authenticated caller.
   *
   * Called once per session, so no two principals ever share a runtime.
   */
  readonly createAgent: (context: {
    readonly principal: Principal
    readonly sessionId: string
  }) => Agent.AgentRuntime<Model, Context_, Principal, ByName, ByTag>

  /**
   * Resolves the caller from the request, returning `undefined` to refuse it.
   *
   * The principal comes from here and nowhere else: a principal taken from
   * request params would let any caller claim any identity.
   */
  readonly authenticate?: ((request: HttpRequest) => Principal | undefined) | undefined

  /**
   * A stable identity for a principal, used to bind a session to its creator.
   *
   * Defaults to a structural key, so an `authenticate` that returns a fresh
   * object per request still matches its own session. Supply this when a
   * principal carries fields that differ between requests of the same caller,
   * such as an issued-at or a token id.
   */
  readonly principalId?: ((principal: Principal) => string) | undefined

  /**
   * Origins a browser may call from. A request carrying an `Origin` that is not
   * listed is refused, which is what stops a page on another site from driving
   * a local server through DNS rebinding.
   */
  readonly allowedOrigins?: ReadonlyArray<string> | undefined

  /** Idle sessions are dropped after this long. Defaults to 30 minutes. */
  readonly sessionTtlMs?: number | undefined

  /** Events kept per session for `Last-Event-ID` resumption. Defaults to 100. */
  readonly replayBuffer?: number | undefined

  readonly serverInfo?: { readonly name: string; readonly version: string } | undefined
}

export interface HttpHandler {
  readonly handle: (request: HttpRequest) => Promise<HttpResponse>
  /** Sessions currently held. */
  readonly sessions: () => ReadonlyArray<string>
  readonly close: () => void
}

/** Versions this server will answer. An absent header means the pre-header release. */
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05'])
const ASSUMED_VERSION = '2025-03-26'

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body,
})

const empty = (status: number, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
})

/** Cryptographically random, and visible ASCII only, as the spec requires. */
const newSessionId = (): string => {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The media type alone, with any parameters (`; charset=utf-8`, `; q=0.9`) dropped. */
const mediaType = (value: string): string => (value.split(';')[0] ?? '').trim().toLowerCase()

/**
 * Whether the client said it can take every one of `required`.
 *
 * An absent `Accept` is not a refusal: RFC 9110 reads it as "any media type is
 * acceptable", so only a header that is present and excludes what this endpoint
 * answers with earns a 406.
 */
const accepts = (header: string | undefined, required: ReadonlyArray<string>): boolean => {
  if (header === undefined) return true
  const offered = header.split(',').map(mediaType)
  return required.every(
    type =>
      offered.includes(type) ||
      offered.includes('*/*') ||
      offered.includes(`${type.split('/')[0]}/*`),
  )
}

/** Key ordering is normalised, so two structurally equal principals agree. */
const structuralId = (value: unknown): string =>
  JSON.stringify(value, (_key, member: unknown) =>
    typeof member === 'object' && member !== null && !Array.isArray(member)
      ? Object.fromEntries(
          Object.entries(member as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : member,
  ) ?? 'undefined'

/** One transport attached to a session's stream. */
interface Subscriber {
  readonly send: (event: SseEvent) => void
  readonly end: (() => void) | undefined
}

interface Session {
  readonly id: string
  /** The principal that initialized it. Only that principal may use it. */
  readonly owner: string
  readonly handler: Handler
  readonly log: Array<SseEvent>
  /** Every open stream. The spec allows more than one at a time. */
  readonly streams: Set<Subscriber>
  nextEventId: number
  lastSeen: number
  terminated: boolean
}

/**
 * Serves a contract over the Streamable HTTP transport.
 *
 * One endpoint answers POST, GET and DELETE. A session is created on
 * `initialize` and identified by `Mcp-Session-Id` afterwards; an unknown
 * session is a 404 so the client re-initializes.
 */
export const httpHandler = <Model, Context_, Principal, ByName, ByTag>(
  options: HttpHandlerOptions<Model, Context_, Principal, ByName, ByTag>,
): HttpHandler => {
  const ttl = options.sessionTtlMs ?? 30 * 60 * 1000
  const replayBuffer = options.replayBuffer ?? 100
  const sessions = new Map<string, Session>()

  const drop = (session: Session): void => {
    // Removed from the map first, so nothing can reach it again, and marked so a
    // transport that subscribes to an already-answered GET is ended at once.
    sessions.delete(session.id)
    session.terminated = true
    session.handler.close()

    // Copied, because a transport is free to unsubscribe from inside its own `end`.
    for (const subscriber of [...session.streams]) {
      try {
        subscriber.end?.()
      } catch {
        // Terminating a session must not fail because one client's transport did.
      }
    }
  }

  const expire = (): void => {
    const cutoff = Date.now() - ttl
    for (const session of [...sessions.values()]) {
      if (session.lastSeen < cutoff) drop(session)
    }
  }

  /** Each message goes to exactly one stream, never broadcast across several. */
  const emit = (session: Session, notification: Notification): void => {
    const event: SseEvent = {
      id: String(session.nextEventId++),
      data: JSON.stringify(notification),
    }
    session.log.push(event)
    if (session.log.length > replayBuffer) session.log.shift()

    const newest = [...session.streams].at(-1)
    newest?.send(event)
  }

  const originAllowed = (request: HttpRequest): boolean => {
    const origin = request.headers['origin']
    // A non-browser client sends no Origin; a browser always does.
    if (origin === undefined) return true
    return (options.allowedOrigins ?? []).includes(origin)
  }

  const versionAccepted = (request: HttpRequest): boolean => {
    const version = request.headers['mcp-protocol-version'] ?? ASSUMED_VERSION
    return SUPPORTED_VERSIONS.has(version)
  }

  const ownerOf = (principal: Principal): string =>
    options.principalId?.(principal) ?? structuralId(principal)

  const lookup = (request: HttpRequest, owner: string): Session | undefined => {
    // Expiry runs even without a session header, so the initialize that creates
    // a new session also clears the idle ones it would otherwise accumulate.
    expire()
    const id = request.headers['mcp-session-id']
    if (id === undefined) return undefined
    const session = sessions.get(id)
    if (session === undefined) return undefined
    // A session id is not a bearer token. Another principal presenting it is
    // answered exactly as an unknown session -- so the id's existence does not
    // leak, and the caller re-initializes into a session of its own -- and its
    // last-seen is left alone, so an outsider cannot keep the session alive.
    if (session.owner !== owner) return undefined
    session.lastSeen = Date.now()
    return session
  }

  const handle = async (request: HttpRequest): Promise<HttpResponse> => {
    if (!originAllowed(request)) {
      return json(403, { error: 'Origin not allowed' })
    }
    if (!versionAccepted(request)) {
      return json(400, { error: 'Unsupported MCP-Protocol-Version' })
    }

    const principal = options.authenticate?.(request)
    if (options.authenticate !== undefined && principal === undefined) {
      return json(401, { error: 'Unauthenticated' })
    }
    const owner = ownerOf(principal as Principal)

    if (request.method === 'DELETE') {
      const session = lookup(request, owner)
      if (session === undefined) return json(404, { error: 'Unknown session' })
      drop(session)
      return empty(204)
    }

    if (request.method === 'GET') {
      // GET is only ever answered with a stream.
      if (!accepts(request.headers['accept'], ['text/event-stream'])) {
        return json(406, { error: 'Accept must include text/event-stream' })
      }

      const session = lookup(request, owner)
      if (session === undefined) return json(404, { error: 'Unknown session' })

      const lastEventId = request.headers['last-event-id']
      const backlog =
        lastEventId === undefined
          ? []
          : session.log.filter(event => Number(event.id) > Number(lastEventId))

      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        stream: {
          backlog,
          subscribe: (send, end) => {
            // The session can be terminated between answering the GET and the
            // transport attaching to it, and that stream must close too.
            if (session.terminated) {
              end?.()
              return () => {}
            }
            const subscriber: Subscriber = { send, end }
            session.streams.add(subscriber)
            return () => session.streams.delete(subscriber)
          },
        },
      }
    }

    if (request.method !== 'POST') {
      return json(405, { error: 'Method not allowed' })
    }

    // A POST may be answered with either a JSON body or a stream, so the client
    // has to be able to take both; the body itself is always JSON.
    if (!accepts(request.headers['accept'], ['application/json', 'text/event-stream'])) {
      return json(406, { error: 'Accept must include application/json and text/event-stream' })
    }
    if (mediaType(request.headers['content-type'] ?? '') !== 'application/json') {
      return json(415, { error: 'Content-Type must be application/json' })
    }

    const message = request.body
    if (message === UNPARSEABLE_BODY) {
      return json(400, failure(null, code.PARSE_ERROR, 'Parse error'))
    }
    if (!isIncoming(message)) {
      return json(400, failure(null, code.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message'))
    }

    const existing = lookup(request, owner)

    // A session is created by initialize, and required by everything else.
    if (existing === undefined) {
      if (request.headers['mcp-session-id'] !== undefined) {
        return json(404, { error: 'Unknown session' })
      }
      if (!isRequest(message) || message.method !== 'initialize') {
        return json(400, failure(null, code.INVALID_REQUEST, 'Expected initialize'))
      }

      const id = newSessionId()
      const session: Session = {
        id,
        owner,
        handler: handler({
          agent: options.createAgent({ principal: principal as Principal, sessionId: id }),
          ...(options.serverInfo === undefined ? {} : { serverInfo: options.serverInfo }),
          onNotification: notification => emit(session, notification),
        }),
        log: [],
        streams: new Set(),
        nextEventId: 1,
        lastSeen: Date.now(),
        terminated: false,
      }
      sessions.set(id, session)

      const response = await session.handler.handle(message)
      return json(200, response, { 'mcp-session-id': id })
    }

    const response = await existing.handler.handle(message)
    // A notification or response carries no reply of its own.
    return response === undefined ? empty(202) : json(200, response)
  }

  return {
    handle,
    sessions: () => [...sessions.keys()],
    close: () => {
      for (const session of [...sessions.values()]) drop(session)
    },
  }
}
