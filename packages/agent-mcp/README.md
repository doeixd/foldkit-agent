# `@foldkit/agent-mcp`

Serves a [`@foldkit/agent`](../agent) contract over the Model Context Protocol
(`2025-06-18`), so an MCP client can use the capabilities an application already
exposes.

```bash
pnpm add @foldkit/agent @foldkit/agent-mcp
```

## Usage

```ts
import { AgentMcp } from '@foldkit/agent-mcp'

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

## Notes

`tools/list` returns what is available now, so a Model-dependent capability
appears and disappears with the Model. `notifications/tools/list_changed` fires
when that advertised set changes — not on every Model change, or an application
that updates on each keystroke would become a notification storm. Set
`debounceMs` when the set itself flaps.

Over stdio, `stdout` carries MCP messages and nothing else. A stray
`console.log` corrupts the stream; diagnostics belong on `stderr`.

Sessions, `Origin` validation and authentication belong to the HTTP transport,
which is not implemented yet. Until then this is a local, single-session server:
the principal comes from the host binding, never from request params.
