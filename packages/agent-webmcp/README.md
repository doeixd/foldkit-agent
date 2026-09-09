# `@foldkit/agent-webmcp`

The browser-native adapter for [`@foldkit/agent`](../agent). It projects exposed
Foldkit Messages into Chrome's experimental WebMCP Imperative API.

WebMCP runs in the page itself, so a tool's `execute` dispatches directly into
the same live Foldkit Runtime the human is already using — no DOM automation,
and no external browser-session bridge.

```text
browser agent -> document.modelContext -> @foldkit/agent-webmcp
              -> Foldkit AgentRuntime  -> Message -> update -> Model + Commands
```

## Install

```bash
pnpm add @foldkit/agent @foldkit/agent-webmcp
```

## Usage

```ts
import { AgentWebMcp } from '@foldkit/agent-webmcp'

const registration = AgentWebMcp.register({ agent: agentRuntime })
```

`agent` is the `AgentRuntime` returned by `Agent.bind(...)`.

Each currently available capability becomes one tool:

```text
capability name     -> tool name
variant description -> description
derived JSON Schema -> inputSchema
Runtime dispatch    -> execute
```

No schema or handler is repeated in this package.

### Options

| Option | Default | Purpose |
| --- | --- | --- |
| `agent` | — | The bound `AgentRuntime`. |
| `modelContext` | `document.modelContext` | The WebMCP producer surface. |
| `signal` | — | Unregisters everything when aborted. |
| `followModel` | `true` | Reconcile registrations as the Model changes. |
| `invocationId` | `crypto.randomUUID()` | Supplies the invocation id. |
| `onError` | — | Reports a failure from a reconcile no caller is awaiting. |

### Returned registration

```ts
registration.refresh()     // reconcile against the current Model
registration.registered()  // capability names currently registered
registration.unregister()  // abort every registration and stop following
```

## Dynamic availability

Tool availability is a projection of Model state, which falls out of TEA:

```ts
RequestedDeleteTodo: {
  name: 'delete_todo',
  description: 'Delete the selected todo',
  available: model => Option.isSome(model.selectedTodoId),
}
```

```text
Todo list          tools: create_todo
user selects todo  -> Model changes
                   -> tools: create_todo, delete_todo
```

The adapter holds one `AbortController` per registered tool. When a capability
becomes unavailable its registration signal is aborted; when it returns, it is
registered again. This is the registration signal, distinct from the execution
signal passed to `execute`, which is forwarded as `Invocation.signal`.

## Errors

A dispatch failure is returned as a tool error rather than thrown, so the
calling agent can act on it:

```text
No such capability: delete_todo
Capability "delete_todo" is not available right now
Not authorized to invoke "delete_todo"
Invalid input for "create_todo"
Capability "create_todo" failed unexpectedly
```

The last covers an unexpected defect, such as the host's `dispatch` throwing.
`execute` never rejects and never echoes the underlying error back to the
caller.

## Why this stays an adapter

WebMCP is experimental and evolving. The types it needs are declared locally in
`src/webmcp.ts` rather than imported, so the browser API can change without the
Foldkit agent contract changing with it.
