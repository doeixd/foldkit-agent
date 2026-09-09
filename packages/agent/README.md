# `@foldkit/agent`

A thin, Schema-first agent layer for Foldkit. It adds two projections and
nothing else:

```text
Model         -> Agent.context   what an agent may see
Message union -> Agent.expose    what an agent may do
```

Everything else is an adapter. `update` remains the single source of truth.

See the [proposal](../../README.md) for the design rationale, and
[examples/todo](../../examples/todo) for a worked example.

## Install

```bash
pnpm add @foldkit/agent
```

`foldkit` and `effect` are peer dependencies.

## Usage

Start from a normal Foldkit application:

```ts
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.Option(Schema.String),
})

type Model = typeof Model.Type

const Message = defineMessageUnion({
  RequestedCreateTodo: { title: Schema.String },
  RequestedRenameTodo: { id: Schema.String, title: Schema.String },
  RequestedDeleteTodo: { id: Schema.String },
  ReceivedTodos: { todos: Schema.Array(Todo) },
  FailedToLoadTodos: { message: Schema.String },
})
```

Bind the constructors to your Model, then declare the contract:

```ts
import { Agent } from '@foldkit/agent'
import { Option, Schema } from 'effect'

const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  // Derives the context schema and the projection from one field list.
  context: Agent.pick(Model, ['selectedTodoId', 'todos']),

  messages: TodoAgent.expose(Message, {
    // A variant that needs nothing but a description can be written as one.
    RequestedCreateTodo: 'Create a new todo',
    RequestedRenameTodo: 'Rename an existing todo',
    RequestedDeleteTodo: {
      name: 'delete_todo',
      description: 'Delete the selected todo',
      available: model => Option.isSome(model.selectedTodoId),
    },
  }),
})
```

`ReceivedTodos` and `FailedToLoadTodos` are never reachable by an agent.
Exposure is opt-in, and there is deliberately no `exposeAll()`.

Bind the contract to a live Runtime:

```ts
const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: {
    model: currentModel,
    dispatch: sendToRuntime,
    subscribe: onModelChange,
  },
})
```

The host must accept every Message the contract can construct -- a wider union
is fine, a narrower one is a type error -- and a contract whose hooks read a
principal must be given a `principal` provider of the matching type.

## API

| Function | Purpose |
| --- | --- |
| `Agent.context({ schema, select })` | The information boundary: what an agent may see. |
| `Agent.pick(Model, keys)` | The same, derived from a list of Model fields. |
| `Agent.expose(Message, variants)` | The capability boundary: what an agent may do. |
| `Agent.variant(config)` | A mapped variant whose callbacks are inferred from its `input`. |
| `Agent.resource(name, options)` | A named read-only projection of Model state. |
| `Agent.define({ context, messages, resources })` | The protocol-neutral contract. |
| `Agent.bind({ definition, host })` | Binds the contract to a live Runtime. |
| `Agent.forModel<Model>()` | The above, with `Model` fixed. |
| `Agent.schema/messages/resources/contextSchema` | Introspection, as plain data. |
| `Agent.toManifest(definition)` | The contract as `agent.json`, for committing and diffing. |
| `Agent.toMarkdown(definition)` | The contract as documentation. |
| `Agent.auditLog(options)` | A bounded record of decisions, refusals included. |

### Variant configuration

```ts
RequestedDeleteTodo: {
  name: 'delete_todo',              // optional; defaults to requested_delete_todo
  description: 'Delete a todo',     // required
  available: model => ...,          // optional: discoverability, not authorization
  authorize: ({ principal, input, model, transport }) => ...,  // optional
  input: Schema.Struct({ id: Schema.String }),                 // optional external input
  toMessage: ({ id }, { invocation }) => ({ id, source: 'Agent' }),
}
```

`input` and `toMessage` must be supplied together; supplying `input` alone is a
type error and a runtime error.

Written inline, `toMessage` and `authorize` are both checked against the
variant's own input -- the payload for a direct variant, the `input` codec's
decoded type for a mapped one -- alongside `principal`, `model` and `transport`.
No annotation is needed.

The one thing `expose` cannot infer inline is `completion`. `success` and
`failure` are inference sites, so written inline `correlate` receives any
Message of the union; `Agent.variant` narrows it to the Messages the contract
actually names:

```ts
RequestedDeleteTodo: Agent.variant({
  description: 'Delete a todo',
  input: Schema.Struct({ id: Schema.String }),
  toMessage: ({ id }, { invocation }) => ({ id, requestId: invocation.id }),
  completion: {
    success: Message.DeletedTodo,
    // `result` is DeletedTodo here, not any Message.
    correlate: (request, result) => request.id === result.id,
  },
}),
```

Reach for it when a completion contract's `correlate` should be checked against
the Messages it names. Otherwise write the variant inline.

Without an explicit `name`, the tag is normalized: `RequestedDeleteTodo` becomes
`requested_delete_todo`. Every capital starts a word, with no special case for
runs of them, so a tag with an acronym is better given an explicit name.

A capability `name` becomes a protocol-facing tool name, so it must match
`[a-zA-Z0-9_-]{1,128}`. An invalid name fails at `Agent.expose`, rather than at
registration where the client would reject it with no reference back to the
contract.

### Introspection

The contract is data, so it is testable without an LLM:

```ts
expect(Agent.messages(AppAgent).map(message => message.name)).toEqual([
  'create_todo',
  'rename_todo',
  'delete_todo',
])
```

### Documenting a contract

The contract is data, so its documentation is generated rather than written:

```ts
writeFileSync('agent.json', JSON.stringify(Agent.toManifest(AppAgent), null, 2))
writeFileSync('AGENT.md', Agent.toMarkdown(AppAgent))
```

Both are reproducible for a given contract and read nothing from the Model, so a
committed manifest makes a change to what an application exposes show up in
review rather than only at runtime.

### Dispatch

A capability can be named by its Message constructor or by its protocol name.
Both are checked, and both infer the input:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id: 'todo-1' })
agentRuntime.messages.dispatch('delete_todo', { id: 'todo-1' })

// Errors, at compile time:
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { todoId: 'x' }) // wrong payload
agentRuntime.messages.dispatch(Message.ReceivedTodos, { todos: [] })        // not exposed
agentRuntime.messages.dispatch('delete_todoo', { id: 'todo-1' })            // no such capability
```

The reference form is worth preferring: it survives a rename of the capability,
and it needs no name at all for a variant that never declared one.

`invocation` is optional. In-app callers can omit it -- the id is generated and
the transport defaults to `in-app` -- while an adapter passes its own:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id: 'todo-1' }, {
  id: crypto.randomUUID(),
  transport: 'webmcp',
  signal,
})
```

An adapter reads a tool name and an unvalidated payload off the wire, so
neither can be checked at compile time. That path is `dispatchUnknown`:

```ts
agentRuntime.messages.dispatchUnknown(nameFromTheWire, payloadFromTheWire, invocation)
```

Input is typed as the **encoded** side of the capability's schema, because that
is what dispatch decodes. A payload of `Schema.NumberFromString` is sent as a
string and reaches `update` as a number.

### Audit

Every decision the contract makes can be recorded, refusals included:

```ts
const audit = Agent.auditLog({
  capacity: 500,
  principal: caller => caller.id, // an id, not the whole identity
})

const agentRuntime = TodoAgent.bind({ definition: AppAgent, host, audit })

audit.entries()
// [{ at, invocation, transport, capability, tag, principal,
//    decision: 'refused', outcome: 'AgentAuthorizationError' }]
```

What it will not keep:

- **The input, unless you ask.** It is caller-supplied and may carry anything.
  `includeInput: true` turns it on, and `redact: ['token']` replaces named
  fields.
- **The principal, without a projection.** No projection, no principal --
  identities carry secrets.
- **The Model.** Never, by any setting.

The log is a bounded ring buffer, and a sink that throws never fails a dispatch:
accountability must not become a new way for a capability to break. Pass any
`AuditSink` to forward entries somewhere durable instead.

This is not Model replay. Re-dispatching a recorded invocation stays an explicit
human action.

### Completion

Dispatching a Message and completing an operation are not always the same event.
A capability can say which Messages finish its work:

```ts
RequestedDeleteTodo: {
  description: 'Delete a todo',
  completion: {
    success: Message.DeletedTodo,
    failure: Message.FailedDeleteTodo,
    correlate: (request, result) => request.id === result.id,
    timeout: Duration.seconds(10),
  },
}
```

`dispatch` then waits, and the result carries
`completion: { status: 'completed' | 'failed', message }`. Without a contract,
validated dispatch remains the boundary and the field is absent.

This needs a host that can see Messages, not only receive them:

```ts
host: {
  model: currentModel,
  dispatch: sendToRuntime,
  observe: onMessage, // required by a contract that declares completion
}
```

A contract declaring completion is refused at `bind` when the host cannot
observe, rather than silently reporting every call as complete.

Waiting always has a deadline; it defaults to 30 seconds.
`AgentCompletionTimeoutError` means the wait ended, **not** that anything was
undone -- the Message reached `update`. The same is true of cancelling while a
completion is pending.

Give `correlate` whenever two invocations of a capability can be in flight at
once. Without it the first matching Message wins, whichever invocation caused it.

An invocation whose signal is already aborted is refused before the Model is
read, and one aborted while decoding or `authorize` is pending never constructs
or dispatches its Message. Both fail with `AgentCancelledError`.

Dispatch runs in a fixed order: resolve the capability, check `available`,
decode input through its Effect Schema, run `authorize`, then construct and
dispatch the Message. A failure at any step means no Message reaches `update`.

`available` is checked before `authorize`, so a capability the Model does not
currently offer reports as unavailable rather than leaking whether the caller
would have been permitted. Decoding rejects undeclared fields, matching the
`additionalProperties: false` the derived JSON Schema advertises. A capability
with no payload accepts `{}` and nothing else -- not `[]`, not a string, and not
an object with fields it never declared.

Failures are tagged and `Schema`-backed, so `Effect.catchTag` narrows them and
an adapter can encode one to JSON and send it across a protocol boundary:

```ts
dispatch.pipe(
  Effect.catchTag('AgentCapabilityUnavailableError', error =>
    Effect.succeed(`${error.capability} is not available`),
  ),
)
```

`AgentUnknownCapabilityError`, `AgentCapabilityUnavailableError`,
`AgentInvalidInputError`, `AgentAuthorizationError`, `AgentCancelledError`, and
`AgentResourceError`
for resource reads. Every `message` is written for the calling agent: it names
the capability and never restates the underlying decode failure, which stays on
the error's `cause` for the application.

Dispatch runs inside an `Agent.dispatch` span annotated with the capability,
transport, and invocation id, so agent-originated transitions show up in
tracing alongside the rest of the application.

## Differences from the proposal

The proposal in the root README describes an API that does not ship with
Foldkit. Three points where this implementation had to differ:

**Runtime integration.** The proposal writes
`Runtime.makeApplication({ agent: AppAgent })`. Foldkit `0.158.2` accepts no
`agent` option, and its runtime handle exposes neither the current Model nor a
dispatch function, so that option cannot be implemented from outside foldkit.
`Agent.bind({ definition, host })` implements the `AgentRuntime` seam the
proposal describes, with the application supplying `model` and `dispatch`. If
Foldkit later accepts an `agent` option, it can construct the same seam.

**`Agent.forModel`.** TypeScript cannot infer `Model` from an `available` or
`select` callback alone, so `available: model => ...` in the proposal's examples
would leave `model` as `any`. `Agent.forModel<Model>()` fixes the Model once and
type-checks every callback against it. `Agent.expose` is still available
directly when the Model does not matter.

**Effect 4.** Foldkit `0.158.2` peer-depends on `effect@4.0.0-rc.112`. The
proposal's snippets use Effect 3 names; `Schema.OptionFromSelf` is
`Schema.Option` here.

Deferred, as the proposal's "Minimal v1" suggests: completion tracking is
recorded on the contract and surfaced through introspection, but validated
dispatch remains the completion boundary.
