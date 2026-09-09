import { Effect, Queue, Stream } from 'effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import type { HttpHandler, HttpHandlerOptions, HttpRequest, SseEvent, SseStream } from './http.js'
import { UNPARSEABLE_BODY, httpHandler } from './http.js'

const encoder = new TextEncoder()

/**
 * Formats one SSE frame.
 *
 * The `id` is what a client echoes back in `Last-Event-ID`, so it has to be on
 * the wire and not only in the server's log.
 */
const frame = (event: SseEvent): Uint8Array =>
  encoder.encode(`id: ${event.id}\ndata: ${event.data}\n\n`)

/** Bridges the adapter's push-style stream onto an Effect `Stream`. */
const toStream = (sse: SseStream): Stream.Stream<Uint8Array> =>
  Stream.callback<Uint8Array>(queue =>
    Effect.gen(function* () {
      // Whatever the client missed while disconnected goes out first, in order.
      for (const event of sse.backlog) {
        yield* Queue.offer(queue, frame(event))
      }

      const unsubscribe = sse.subscribe(event => {
        Queue.offerUnsafe(queue, frame(event))
      })

      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
      // Held open until the client disconnects, which closes the scope.
      yield* Effect.never
    }),
  )

/** Header names arrive lowercased already, which is what the core expects. */
const toHttpRequest = (
  request: HttpServerRequest.HttpServerRequest,
  body: unknown,
): HttpRequest => ({
  method: request.method,
  headers: request.headers,
  ...(body === undefined ? {} : { body }),
})

export interface HttpAppOptions<
  Model,
  Context_,
  Principal,
  ByName,
  ByTag,
> extends HttpHandlerOptions<Model, Context_, Principal, ByName, ByTag> {
  /** Reuses an existing handler instead of creating one, so sessions can be shared. */
  readonly server?: HttpHandler | undefined
}

/**
 * Serves a contract as an Effect HTTP application.
 *
 * This is the entry point to prefer: it runs behind any Effect HTTP server, or
 * as a plain web handler via `HttpEffect.toWebHandler`, on Node, Bun, Deno or a
 * worker. The session and security rules live in the transport-neutral core;
 * this is the I/O.
 *
 * @example
 * ```ts
 * const handler = HttpEffect.toWebHandler(AgentMcp.httpApp({ createAgent, authenticate }))
 * ```
 */
export const httpApp = <Model, Context_, Principal, ByName, ByTag>(
  options: HttpAppOptions<Model, Context_, Principal, ByName, ByTag>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => {
  const server = options.server ?? httpHandler(options)

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    // A body that is absent or unparseable is not a reason to fail the request:
    // the core answers it with the JSON-RPC error the client expects, and the
    // sentinel keeps malformed JSON (-32700) apart from a valid but wrong-shaped
    // value (-32600).
    const body =
      request.method === 'POST'
        ? yield* Effect.orElseSucceed(request.json, () => UNPARSEABLE_BODY)
        : undefined

    const response = yield* Effect.promise(() => server.handle(toHttpRequest(request, body)))

    if (response.stream !== undefined) {
      return HttpServerResponse.stream(toStream(response.stream), {
        status: response.status,
        headers: response.headers,
      })
    }

    return response.body === undefined
      ? HttpServerResponse.empty({ status: response.status, headers: response.headers })
      : yield* Effect.orDie(
          HttpServerResponse.json(response.body, {
            status: response.status,
            headers: response.headers,
          }),
        )
  })
}
