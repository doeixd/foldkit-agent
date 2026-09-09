# `foldkit-agent-mcp`

Serves a [`foldkit-agent`](../agent) contract over the Model Context Protocol
(`2025-06-18`), so an MCP client can use the capabilities an application already
exposes.

```bash
pnpm add foldkit-agent foldkit-agent-mcp
```

## Usage

```ts
import { AgentMcp } from 'foldkit-agent-mcp'

AgentMcp.stdio({ agent: agentRuntime })
```

The protocol mapping is a transport-free message handler, so it can be driven
directly:

```ts
const served = AgentMcp.handler({ agent: agentRuntime, onNotification: send })

await served.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

## Mapping

| MCP | Contract |
| --- | --- |
| `tools/list` | the capabilities `available` in the current Model |
| `tools/call` | `dispatchUnknown(name, arguments, invocation)` |
| `resources/list` and `resources/read` | `app://<name>`, plus `app://context` |
| `notifications/tools/list_changed` | the advertised set changed |
| `notifications/cancelled` | aborts that invocation |

## Errors

The spec splits these, and the split matters:

- An unknown tool, or arguments that fail the advertised schema, are the
  caller's fault at the protocol level: **JSON-RPC error `-32602`**.
- Everything the application decided — unavailable, unauthorized, cancelled, a
  declared failure — is a **result with `isError: true`**.

An authorization refusal reported as a protocol error would have clients retry
it as a transport fault, which is why it is not one.

## Over HTTP

`httpApp` serves the Streamable HTTP transport as an Effect HTTP application,
so it runs behind any Effect server or as a plain web handler, on Node, Bun,
Deno or a worker:

```ts
import * as HttpEffect from 'effect/unstable/http/HttpEffect'

const handler = HttpEffect.toWebHandler(
  AgentMcp.httpApp({
    createAgent: ({ principal }) => bindAgentFor(principal),
    authenticate: request => verify(request.headers['authorization']),
    allowedOrigins: ['https://app.example'],
  }),
)

const response = await handler(request) // Request -> Response
```

Underneath, `httpHandler` holds the session and security rules against a
transport-neutral request shape. Reach for it directly only to embed the server
in something that is not Effect-based:

```ts
const server = AgentMcp.httpHandler({
  // One runtime per session. No two principals ever share one.
  createAgent: ({ principal }) => bindAgentFor(principal),

  // The principal comes from here and nowhere else.
  authenticate: request => verify(request.headers['authorization']),

  // A request carrying an Origin that is not listed is refused.
  allowedOrigins: ['https://app.example'],
})

const response = await server.handle({ method, headers, body })
```

A session is created by `initialize` and identified by `Mcp-Session-Id`
afterwards. An unknown or expired session answers 404, which is the client's
signal to re-initialize; `DELETE` terminates one.

A session id is not a bearer token. A session belongs to the principal that
initialized it, and another principal presenting the id is answered exactly as
an unknown session — so the id's existence does not leak, and that caller
re-initializes into a session of its own. Where a principal carries fields that
differ between requests of the same caller, give `principalId` to say what
identity means.

`GET` opens an SSE stream for server notifications. Each event carries an id, so
a client that reconnects with `Last-Event-ID` is sent what it missed and nothing
it already saw. An event goes to exactly one stream, never broadcast across
several.

### What this transport will not do

- **No `Origin`, no allowlist, no entry.** A request carrying an `Origin` that is
  not configured is refused, including when no origins are configured at all.
  This is the DNS-rebinding defence the spec requires; a non-browser client
  sends no `Origin` and is unaffected.
- **A principal in request params is ignored.** Identity comes from
  `authenticate`. Reading it from params would let any caller claim any identity
  and walk straight through `authorize`.
- Bind to localhost when serving locally, and require authentication otherwise.

## Notes

`tools/list` returns what is available now, so a Model-dependent capability
appears and disappears with the Model. `notifications/tools/list_changed` fires
when that advertised set changes — not on every Model change, or an application
that updates on each keystroke would become a notification storm. Set
`debounceMs` when the set itself flaps.

Over stdio, `stdout` carries MCP messages and nothing else. A stray
`console.log` corrupts the stream; diagnostics belong on `stderr`.

Over stdio there is one session and one runtime, bound by the caller; sessions,
`Origin` validation and authentication are the HTTP transport's job.
