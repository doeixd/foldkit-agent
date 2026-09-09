# `foldkit-agent`

> A thin, Schema-first agent layer for Foldkit.
>
> Project a Foldkit application's **Model** and **Message union** into a deliberate agent interface, then expose the same contract through **WebMCP**, MCP, in-app agents, A2A, or other protocols without implementing application behavior twice.

```text
                         Foldkit application

                Model                         Message
                  │                              │
                  │ project                      │ expose
                  ▼                              ▼
             agent context              agent-safe Message union
                  │                              │
                  └──────────────┬───────────────┘
                                 ▼
                         Agent definition
                                 │
               ┌─────────┬───────┼────────┬─────────┐
               ▼         ▼       ▼        ▼         ▼
            WebMCP      MCP   in-app AI   A2A    future
```

## Status

This document is both the design rationale and the documentation for what is
implemented in this repository:

| Package | What it is |
| --- | --- |
| [`foldkit-agent`](./packages/agent) | The protocol-neutral contract: `context`, `expose`, `define`, `resource`, introspection, and the bound `AgentRuntime`. |
| [`foldkit-agent-webmcp`](./packages/agent-webmcp) | The browser adapter, projecting exposed Messages into `document.modelContext`. |
| [`foldkit-agent-mcp`](./packages/agent-mcp) | The external MCP adapter: a transport-free protocol handler, plus stdio and HTTP. |
| [`foldkit-agent-a2a`](./packages/agent-a2a) | The A2A adapter: an Agent Card and `message/send` as tasks. |

It is deliberately built on Foldkit's existing architecture rather than
introducing a second application-action system.

These are community packages, published unscoped as Foldkit itself is. They are
not affiliated with or endorsed by the Foldkit maintainers, and the names are
theirs for the asking.

One part of the original proposal cannot be built from outside Foldkit. As of
`v0.158.2`, `Runtime.makeApplication` accepts no `agent` option and its runtime
handle exposes neither the current Model nor a dispatch function, so the
application supplies that seam through `Agent.bind`. See
[Runtime integration](#runtime-integration).

As of Foldkit `v0.158.2`, Foldkit already has most of the underlying machinery:

- the application Model is defined with Effect `Schema`;
- application interactions are represented as a Schema-backed `Message` union;
- `view` emits Messages instead of owning arbitrary event behavior;
- `update` is the authoritative state transition function;
- Commands describe effects outside `update`;
- the Runtime already knows how to validate and dispatch Messages;
- `@foldkit/devtools-mcp` can expose the live Model, Message history, Message JSON Schema, replay, and Schema-validated Message dispatch during development.

The web platform is moving toward a compatible model. Chrome's experimental WebMCP Imperative API allows a page to register structured tools with:

```ts
document.modelContext.registerTool({
  name,
  description,
  inputSchema,
  execute,
})
```

That makes Foldkit unusually well suited to browser-native agents: an exposed Message can become a WebMCP tool whose `execute` function validates input and dispatches directly into the **same live browser Runtime the user is already interacting with**.

# Why

Most applications accidentally define the same capability several times.

```text
Human UI
   ↓
event handler
   ↓
API / business logic

Agent
   ↓
tool definition
   ↓
API / business logic

MCP / WebMCP
   ↓
another schema + handler
   ↓
API / business logic
```

Foldkit already has a better primitive: **interactions are data**.

```ts
h.OnClick(
  Message.RequestedDeleteTodo({ id })
)
```

The UI does not own the behavior. It emits a typed Message.

So the proposal is:

> If a semantic interaction already exists in the Foldkit Message union, making it agent-accessible should require metadata, not another implementation.

The same transition can originate from either surface:

```text
Human UI ─────────────┐
                      ▼
           RequestedDeleteTodo
                      ▲
Agent / MCP / WebMCP ─┘
                      │
                      ▼
                    update
                      │
                      ▼
              Model + Commands
```

No DOM simulation. No parallel action API. No agent-only business logic.

## Why WebMCP is an especially good fit

External MCP has an awkward problem for browser-state applications:

```text
external agent
      ↓
MCP server
      ↓
session/browser bridge
      ↓
correct Foldkit Runtime
```

WebMCP runs in the page itself:

```text
browser agent
      ↓
document.modelContext
      ↓
foldkit-agent-webmcp
      ↓
current Foldkit Runtime
      ↓
Message → update → Commands
```

The agent is attached to the same page and the same state machine as the human. There is no separate server bridge required merely to identify what application state the user means.

That makes WebMCP a strong candidate for the **first production adapter** for this proposal.

# The model

Foldkit already gives us the important pieces:

| Foldkit primitive | Agent interpretation |
| --- | --- |
| `Model` | What is true now / what context is available |
| `Message` | What can happen |
| `update` | What a Message means |
| `Command` | What effectful work follows |
| `Schema` | Machine-readable runtime contract |

`foldkit-agent` adds two projections:

```text
Model
  └── Agent.context(...) ───► what an agent may see

Message union
  └── Agent.expose(...) ────► what an agent may do
```

Everything else is an adapter.

```text
                     AppAgent
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
      WebMCP            MCP          in-app agent
        │               │                │
 registerTool()    tools/resources    LLM tools
```

The core package does **not** make MCP or WebMCP the source of truth. Foldkit remains the architecture.

# Installation

```bash
pnpm add foldkit-agent
```

Browser-native WebMCP:

```bash
pnpm add foldkit-agent foldkit-agent-webmcp
```

`foldkit` and `effect` are peer dependencies. Foldkit `0.158.2` peer-depends on
`effect@4.0.0-rc.112`, so the snippets here use Effect 4 names.

External MCP:

```bash
pnpm add foldkit-agent foldkit-agent-mcp
```

# Quick start

Assume a normal Foldkit application:

```ts
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

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
  RequestedCreateTodo: {
    title: Schema.String,
  },

  RequestedRenameTodo: {
    id: Schema.String,
    title: Schema.String,
  },

  RequestedDeleteTodo: {
    id: Schema.String,
  },

  ReceivedTodos: {
    todos: Schema.Array(Todo),
  },

  FailedToLoadTodos: {
    message: Schema.String,
  },
})
```

Bind the constructors to this application's Model. TypeScript cannot infer a
Model from a `select` or `available` callback alone, so fixing it once removes
the annotation from every call site:

```ts
import { Agent } from "foldkit-agent"

const TodoAgent = Agent.forModel<Model>()
```

Project the Model state that agents may observe:

```ts
const context = Agent.pick(Model, ["selectedTodoId", "todos"])
```

`Agent.pick` derives the context schema and the projection from one field list.
Where the projection is not a straight subset of the Model, write it out with
`Agent.context({ schema, select })`.

Expose a subset of the **existing Message union**. A variant that needs nothing
but a description can be written as one:

```ts
const messages = TodoAgent.expose(Message, {
  RequestedCreateTodo: "Create a new todo",
  RequestedRenameTodo: "Rename an existing todo",

  RequestedDeleteTodo: {
    name: "delete_todo",
    description: "Delete a todo",
  },
})
```

Combine them:

```ts
const AppAgent = TodoAgent.define({
  context,
  messages,
})
```

Bind the definition to the live Runtime:

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

From that one definition, protocol adapters derive their tool surfaces
automatically.

# What gets generated

For:

```ts
Agent.expose(Message, {
  RequestedDeleteTodo: {
    name: "delete_todo",
    description: "Delete a todo",
  },
})
```

the adapter already knows:

```text
Message tag          → RequestedDeleteTodo
tool name            → delete_todo
description          → Delete a todo
input Schema         → { id: string }
Message constructor  → Message.RequestedDeleteTodo
execution            → Runtime.dispatch(...)
```

The WebMCP adapter mechanically produces the equivalent of:

```ts
await document.modelContext.registerTool({
  name: "delete_todo",
  description: "Delete a todo",
  inputSchema: /* derived JSON Schema */,

  execute: async (input, { signal }) =>
    agentRuntime.messages.dispatchUnknown(
      "delete_todo",
      input,
      {
        id: crypto.randomUUID(),
        transport: "webmcp",
        signal,
      },
    ),
})
```

`dispatchUnknown` rather than `dispatch`, because the name and payload arrive
from the wire and cannot be checked at compile time.

An external MCP adapter can expose the same contract through `tools/list` and `tools/call`.

There is no separately maintained tool input type or executor.

# Why expose the Message union?

The Message union is already Foldkit's closed vocabulary of application events.

A less Foldkit-native API would introduce a second action system:

```ts
Agent.tool({
  name: "delete_todo",
  input: ...,
  execute: ...,
})
```

Instead:

```ts
Agent.expose(Message, {
  RequestedDeleteTodo: {
    description: "Delete a todo",
  },
})
```

means:

> This existing Message variant is meaningful and safe for an agent to originate.

Conceptually:

```text
Message
  ├── RequestedCreateTodo   ─┐
  ├── RequestedRenameTodo   ─┼──► agent-safe Message union
  ├── RequestedDeleteTodo   ─┘
  ├── ReceivedTodos
  └── FailedToLoadTodos
```

Exposure is explicit and opt-in. Internal Messages remain internal.

# Designing Messages for agents

Prefer semantic, surface-independent Messages for capabilities that may originate outside the UI.

Less useful:

```ts
ClickedDeleteButton
```

Better:

```ts
RequestedDeleteTodo
```

Then both surfaces can speak the same language:

```text
button ──────────────┐
                     ▼
          RequestedDeleteTodo
                     ▲
agent ───────────────┘
```

Good candidates for exposure:

```text
RequestedCreateProject
RequestedRenameTodo
RequestedArchiveThread
SelectedWorkspace
SubmittedSearch
RequestedNavigation
```

Usually poor candidates:

```text
HoveredCard
FocusedTextField
OpenedTooltip
ReceivedTodos
CompletedAnimation
FailedInternalRetry
```

The rule is not "user Message vs system Message." Ask:

> Does this Message represent a coherent capability that another interaction surface could legitimately originate?

# API reference

## `Agent.define`

Creates the protocol-neutral agent contract for an application.

```ts
const AppAgent = Agent.define({
  context,
  messages,
  resources,
})
```

Signature:

```ts
Agent.define<Model, Context, Principal, ByName, ByTag>(options: {
  context?: Agent.Context<Model, Context>
  messages: Agent.ExposedMessages<Model, Principal, ByName, ByTag>
  resources?: ReadonlyArray<Agent.Resource<Model, unknown>>
}): Agent.Definition<Model, Context, Principal, ByName, ByTag>
```

`ByName` and `ByTag` carry each capability's input type. They are inferred, and
they are what makes [dispatch](#dispatch) checked.

`Agent.define` contains no model-provider or MCP/WebMCP configuration. It describes the application's agent contract only.

## `Agent.context`

Defines the safe projection of Model state available to agent surfaces.

```ts
const context = Agent.context({
  schema: AgentContext,

  select: model => ({
    route: model.route,
    selectedTodoId: model.selectedTodoId,
  }),
})
```

Signature:

```ts
Agent.context<Model, Context>(options: {
  schema: Schema.Codec<Context>
  select: (model: Model) => Context
}): Agent.Context<Model, Context>
```

### `Agent.pick`

When the projection is a straight subset of the Model, `Agent.pick` derives both
halves from one field list:

```ts
const context = Agent.pick(Model, ["selectedTodoId", "todos"])
```

Writing the field list twice invites the schema and `select` to drift, and a
mismatch would only surface when the context is read.

### `schema`

Effect Schema for the projected context. It provides runtime validation, documentation, and JSON Schema derivation.

### `select`

Pure projection from the current Foldkit Model. It should not perform effects.

Do not expose the entire Model by default. The projection is an information boundary.

## `Agent.expose`

Creates an agent-safe projection of a Foldkit Message union.

```ts
const messages = Agent.expose(Message, {
  RequestedCreateTodo: {
    description: "Create a todo",
  },

  RequestedDeleteTodo: {
    description: "Delete a todo",
  },
})
```

A variant that needs nothing but a description can be written as one:

```ts
const messages = Agent.expose(Message, {
  RequestedCreateTodo: "Create a todo",
  RequestedDeleteTodo: "Delete a todo",
})
```

Signature:

```ts
Agent.expose<Cases, Variants, Model, Principal>(
  Message: MessageUnion<Cases>,
  variants: Variants,
): Agent.ExposedMessages<
  Model,
  Principal,
  CapabilitiesByName<Cases, Variants>,
  CapabilitiesByTag<Cases, Variants>
>
```

For every selected variant, Foldkit derives:

- Message tag;
- constructor;
- payload Effect Schema;
- JSON Schema;
- default external name;
- decoding logic;
- dispatch logic;
- the capability's input type, for checked dispatch.

There is no `exposeAll()`. Exposure is a capability boundary.

## `Agent.VariantConfig`

Configuration for one exposed Message variant.

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete a todo",
  available: model => Option.isSome(model.selectedTodoId),
  authorize,
  completion,
}
```

The shape:

```ts
interface VariantConfig<
  MessageInput,
  ExternalInput = MessageInput,
  Model = unknown,
  Principal = unknown,
> {
  readonly name?: string
  readonly description: string

  readonly available?: (model: Model) => boolean

  readonly input?: Schema.Schema<ExternalInput>
  readonly toMessage?: (
    input: ExternalInput,
    context: Agent.InvocationContext<Model, Principal>,
  ) => MessageInput

  readonly authorize?: (
    request: Agent.AuthorizationRequest<
      ExternalInput,
      Model,
      Principal
    >,
  ) =>
    | boolean
    | Effect.Effect<boolean, Agent.AuthorizationError>

  readonly completion?: Agent.Completion<unknown, unknown>
}
```

### `name`

Optional protocol-facing capability name.

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete a todo",
}
```

Without an override, the Message tag is normalized: `RequestedDeleteTodo`
becomes `requested_delete_todo`. Every capital starts a word, with no special
case for runs of them, so a tag containing an acronym is better given an
explicit name. The name must match `[a-zA-Z0-9_-]{1,128}`, which is what MCP and
WebMCP accept, and an invalid one fails at `Agent.expose` rather than at
registration.

The internal Message tag never changes.

### `description`

Required natural-language description of semantic behavior.

Prefer:

```text
Delete a todo
```

over:

```text
Act like the user clicked the red Delete button
```

### `available`

Optional Model-dependent capability predicate.

```ts
RequestedDeleteTodo: {
  description: "Delete the selected todo",

  available: model =>
    Option.isSome(model.selectedTodoId),
}
```

Signature:

```ts
readonly available?: (model: Model) => boolean
```

This is especially useful for WebMCP. Tool discovery can follow the live Foldkit Model:

```text
Model changes
     ↓
available(model)
     ↓
agent-visible capability set
     ↓
WebMCP registrations reconciled
```

The adapter holds one `AbortController` per registered tool: when a capability
becomes unavailable its registration signal is aborted, and when it returns it
is registered again.

`available` controls **discoverability/capability presence**, not authorization. Calls may still require `authorize`, and backend/domain authorization remains authoritative.

### `authorize`

Optional pre-dispatch authorization hook.

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",

  authorize: ({ principal, input }) =>
    principal.canDeleteTodo(input.id),
}
```

The request:

```ts
interface AuthorizationRequest<Input, Model, Principal> {
  readonly principal: Principal
  readonly input: Input
  readonly model: Model
  readonly transport: Agent.Transport
}
```

Denied calls never dispatch a Message. `available` is checked first, so a
capability the Model does not currently offer reports as unavailable rather than
leaking whether the caller would have been permitted.

This is an additional interface boundary, not a replacement for authorization in Commands, APIs, services, or databases.

### `input` + `toMessage`

Most capabilities should expose their existing Message payload directly.

Sometimes the internal Message contains fields that an external agent should not provide:

```ts
const Message = defineMessageUnion({
  RequestedDeleteTodo: {
    id: Schema.String,
    source: Source,
    requestId: Schema.String,
  },
})
```

Use an explicit external input mapping:

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete a todo",

  input: Schema.Struct({
    id: Schema.String,
  }),

  toMessage: ({ id }, { invocation }) =>
    Message.RequestedDeleteTodo({
      id,
      source: "Agent",
      requestId: invocation.id,
    }),
}
```

If `input` is provided, `toMessage` is required.

The common case should remain the terse one:

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",
}
```

### `completion`

Dispatching a Message and completing an operation are not always the same event.

```text
RequestedDeleteTodo
        ↓
      update
        ↓
   DeleteTodo Command
        ↓
 DeletedTodo / FailedDeleteTodo
```

An exposed capability may optionally describe completion:

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",

  completion: {
    success: Message.DeletedTodo,
    failure: Message.FailedDeleteTodo,

    correlate: (request, result) =>
      request.id === result.id,
  },
}
```

Dispatch waits for a completing Message when a variant declares one, and reports
how the operation finished. Without a completion contract, successful validated
dispatch remains the boundary:

```ts
interface Completion<Request, Success extends AnyMessage, Failure extends AnyMessage> {
  readonly success:
    | MessageConstructor<Success>
    | ReadonlyArray<MessageConstructor<Success>>

  readonly failure?:
    | MessageConstructor<Failure>
    | ReadonlyArray<MessageConstructor<Failure>>

  readonly correlate?: (
    request: Request,
    result: Success | Failure,
  ) => boolean

  readonly timeout?: Duration.Input
}
```

Without a completion contract, successful validated dispatch is the completion boundary.

## `Agent.resource`

Defines read-only Model state that can be requested separately from the default context.

```ts
const TodosResource = Agent.resource("todos", {
  description: "The user's current todos",
  schema: Schema.Array(Todo),
  read: model => model.todos,
})
```

Signature:

```ts
Agent.resource<Model, Value>(
  name: string,
  options: {
    description: string
    schema: Schema.Schema<Value>
    read: (model: Model) => Value
  },
): Agent.Resource<Model, Value>
```

External MCP can map this naturally to a resource such as:

```text
app://todos
```

Current WebMCP producer APIs are tool-oriented rather than exposing the same MCP Resources surface. A WebMCP adapter may therefore leave resources out, or optionally project a resource as a read-only tool such as `get_todos`.

The core contract should not distort itself around either protocol.

## Introspection

Because the agent contract is data, it should be inspectable and testable without an LLM.

```ts
Agent.schema(AppAgent)
Agent.messages(AppAgent)
Agent.contextSchema(AppAgent)
```

Signatures:

```ts
Agent.schema(definition): Agent.Schema
Agent.messages(definition): ReadonlyArray<Agent.MessageDescriptor>
Agent.resources(definition): ReadonlyArray<Agent.ResourceDescriptor>
Agent.contextSchema(definition): Record<string, unknown> | undefined
```

A `MessageDescriptor` carries the protocol `name`, the internal `tag`, the
`description`, the derived `inputSchema`, and two flags: `modelDependent` when
the variant declares `available`, and `requiresAuthorization` when it declares
`authorize`.

Adapters can depend on this protocol-neutral description rather than inspecting application internals.

## Invocation context

Adapters should normalize invocation metadata before dispatch.

```ts
interface InvocationContext<Model, Principal> {
  readonly model: Model
  readonly principal: Principal
  readonly invocation: Agent.Invocation
}

interface Invocation {
  readonly id: string
  readonly transport: Agent.Transport
  readonly signal?: AbortSignal
}
```

The optional `signal` gives adapters a common cancellation primitive. For WebMCP
it maps from the cancellation signal passed to a tool's `execute` function.

The whole `Invocation` is optional at the call site. In-app callers omit it: the
id is generated and the transport defaults to `in-app`.

# Runtime integration

The Foldkit Runtime already owns the pieces an agent adapter needs:

- current Model;
- Message validation;
- Message dispatch;
- Message history;
- Command execution.

The natural integration point would be:

```ts
Runtime.makeApplication({
  // existing configuration
  agent: AppAgent,
})
```

Foldkit `0.158.2` does not accept that option, and `MakeRuntimeReturn` exposes
neither the current Model nor a dispatch function, so it cannot be implemented
from outside Foldkit. Until it can, the application supplies the seam:

```ts
const agentRuntime = Agent.bind({
  definition: AppAgent,

  host: {
    model: () => currentModel,          // read the Model
    dispatch: message => send(message),  // send a Message into the Runtime
    subscribe: onModelChange,            // optional: lets adapters reconcile
    principal: () => currentPrincipal,   // optional: identity for authorize
  },
})
```

If Foldkit later accepts an `agent` option, it can construct the same seam
internally without the contract changing.

Binding an abstract `Agent.Definition` to a live runtime gives:

```text
Agent.Definition
      +
Foldkit Runtime
      ↓
bound AgentRuntime
      │
      ├── context
      ├── resources.read(name)
      ├── messages.list
      └── messages.dispatch(name, input, invocation)
```

The seam:

```ts
interface AgentRuntime<Model, Context, Principal, ByName, ByTag> {
  readonly definition: Agent.Definition<Model, Context, Principal, ByName, ByTag>

  readonly context: Effect.Effect<Context | undefined>

  readonly resources: {
    readonly read: (
      name: string,
    ) => Effect.Effect<unknown, Agent.ResourceError>
  }

  readonly messages: {
    /** Every exposed capability. */
    readonly list: Effect.Effect<ReadonlyArray<Agent.MessageDescriptor>>

    /** Only those whose `available(model)` currently holds. */
    readonly available: Effect.Effect<ReadonlyArray<Agent.MessageDescriptor>>

    /** Checked: names a capability by Message constructor or by name. */
    readonly dispatch: Agent.Dispatch<ByName, ByTag>

    /** The protocol path: a name and payload that came off the wire. */
    readonly dispatchUnknown: (
      name: string,
      input: unknown,
      invocation?: Partial<Agent.Invocation>,
    ) => Effect.Effect<Agent.DispatchResult, Agent.DispatchError>
  }

  /** Model changes, when the host supports it. Returns an unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
}
```

Protocol adapters bind to this seam rather than reaching into `update` directly.

## Dispatch

A capability is named by its Message constructor or by its protocol name. Both
are checked, and both infer the input:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id })
agentRuntime.messages.dispatch("delete_todo", { id })
```

Each of these fails to compile:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { todoId }) // wrong payload
agentRuntime.messages.dispatch(Message.ReceivedTodos, { todos })        // not exposed
agentRuntime.messages.dispatch("delete_todoo", { id })                  // no such capability
```

Prefer the reference form: it survives renaming a capability, and it needs no
name at all for a variant that never declared one.

Dispatch runs in a fixed order — resolve the capability, check `available`,
decode input through its Effect Schema, run `authorize`, then construct and
dispatch the Message. A failure at any step means no Message reaches `update`.
Decoding rejects undeclared fields, matching the `additionalProperties: false`
that the derived JSON Schema advertises.

Failures are `Schema`-backed, so `Effect.catchTag` narrows them and an adapter
can encode one to JSON and send it on: `AgentUnknownCapabilityError`,
`AgentCapabilityUnavailableError`, `AgentInvalidInputError`,
`AgentAuthorizationError`, and `AgentResourceError`. Every `message` is written
for the calling agent and never restates application internals.

Dispatch runs inside an `Agent.dispatch` span annotated with the capability,
transport, and invocation id.

# WebMCP adapter

```text
foldkit-agent-webmcp
```

Minimal usage:

```ts
import { AgentWebMcp } from "foldkit-agent-webmcp"

const registration = AgentWebMcp.register({ agent: agentRuntime })
```

The registration exposes `refresh()` to reconcile against the current Model,
`registered()` for the capability names currently registered, and
`unregister()`. See the [package README](./packages/agent-webmcp) for the
options.

The adapter projects exposed Message variants into `document.modelContext.registerTool(...)` calls.

## Tool registration

For each currently available capability:

```text
Message tag          → tool name
Variant description  → description
Effect Schema        → inputSchema
Runtime dispatch     → execute
```

Application authors do not repeat schemas or handlers in the WebMCP package.

## Lifecycle

WebMCP distinguishes two cancellation concerns:

```text
registration signal
  = should this tool remain registered?

execution signal
  = is this invocation still wanted?
```

That maps well onto Foldkit:

```text
Model / route lifecycle
        ↓
registration AbortSignal

WebMCP invocation
        ↓
Agent.Invocation.signal
        ↓
Command / Effect cancellation where supported
```

## Dynamic availability

`available(model)` lets WebMCP tool discovery follow the live application state.

Example:

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete the selected todo",

  available: model =>
    Option.isSome(model.selectedTodoId),
}
```

Possible behavior:

```text
Todo list
  tools: create_todo, search_todos

user selects todo
        ↓
Model changes
        ↓
  tools: create_todo, search_todos,
         rename_todo, delete_todo
```

This is a particularly natural consequence of TEA: **tool availability itself becomes a projection of Model state**.

## Why WebMCP stays an adapter

WebMCP is still experimental and evolving. Foldkit core should not depend on it.

```text
foldkit-agent
  = stable application capability model

foldkit-agent-webmcp
  = current browser protocol interpretation
```

That lets the browser API change without forcing the Foldkit agent contract to change with it.

# External MCP adapter

```text
foldkit-agent-mcp
```

The contract is protocol-neutral, so this adapter reads the same descriptors the
WebMCP one does. The protocol mapping is a transport-free handler; `stdio` and
`httpHandler` attach it to a process or a server.

Conceptually:

```ts
import { AgentMcp } from "foldkit-agent-mcp"

AgentMcp.stdio({ agent: agentRuntime })
```

or, with no transport attached:

```ts
const served = AgentMcp.handler({ agent: agentRuntime, onNotification: send })
await served.handle(message)
```

The exact server API should follow Foldkit's eventual server conventions.

## Projection

Each exposed Message becomes one MCP tool by default:

```text
create_todo(title)
rename_todo(id, title)
delete_todo(id)
```

Context may be exposed as a conventional resource:

```text
app://context
```

and `Agent.resource(...)` can become resources such as:

```text
app://todos
```

## Browser Runtime state

Unlike WebMCP, an external MCP client may live outside the browser that owns the Model.

Production external MCP therefore needs a transport/session layer that can bind the caller to the correct Runtime. `httpHandler` is that layer: one runtime per authenticated session, with the principal taken from the transport rather than from request params.

```text
MCP client
    ↓
authenticated transport
    ↓
Runtime/session identity
    ↓
Foldkit AgentRuntime
```

The existing DevTools MCP demonstrates a related topology during development, but production agent access should not simply expose DevTools.

# Optional Agent Native adapter: best of both worlds

`foldkit-agent` should remain independent of Agent Native, but it can optionally use Agent Native as a **runtime/protocol interpreter** for infrastructure that Agent Native already implements well.

The dependency direction matters:

```text
              Foldkit application
                     │
             Model + Message
                     │
              foldkit-agent
                     │
              Agent.Definition
                     │
        ┌────────────┼──────────────┐
        ▼            ▼              ▼
     WebMCP     Agent Native      other
     adapter       adapter        adapters
                     │
             mature remote-agent
              infrastructure
```

Foldkit remains the source of truth. Agent Native does **not** become a second application model.

A prototype of this exists on the `prototype/agent-native` branch as
`foldkit-agent-native`. It is private and only partly verified against the
framework, so it is not part of the published set:

```text
foldkit-agent-native
```

with an API such as:

```ts
import { AgentNative } from "foldkit-agent-native"
import { registerPackageActions } from "@agent-native/core/server"

registerPackageActions(
  AgentNative.actions({
    definition: AppAgent,
    resolveRuntime: ctx => runtimeFor(ctx),
  }),
)
```

Agent Native discovers actions from files, but it also exports
`registerPackageActions` for packages to contribute them in memory. That is what
the prototype builds on, so there is no generated file to outlive the capability
it came from.

The adapter would compile exposed Foldkit Messages into generated Agent Native Actions:

```text
Agent.expose(Message.RequestedDeleteTodo)
        ↓
generated Agent Native Action
        ↓
Agent Native protocol/runtime infrastructure
        ↓
Foldkit AgentRuntime.dispatch("delete_todo", input)
        ↓
Message.RequestedDeleteTodo(input)
        ↓
update
```

Conceptually, the generated Action is only an adapter artifact:

```ts
defineAction({
  schema: /* derived from the Foldkit Message Schema */,

  run: input =>
    foldkitAgentRuntime.messages.dispatchUnknown(
      "delete_todo",
      input,
      invocation,
    ),
})
```

Application behavior still lives in `update` and Commands, not in `run`.

## What Foldkit could reuse

Where Agent Native remains modular enough, the adapter could reuse its mature infrastructure for things such as:

- remote MCP;
- OAuth and authenticated external agents;
- A2A;
- CLI exposure;
- public-agent capability policies;
- deep links back into the application;
- MCP Apps / embedded UI;
- agent runtime and chat infrastructure;
- jobs and durable work;
- observability and handoffs.

This is particularly attractive for remote/headless access, where Foldkit otherwise has to build transport, identity, authentication, and Runtime/session routing itself.

## What should stay Foldkit-native

The core application contract should not depend on Agent Native:

```text
Model
Message
update
Command
Agent.context
Agent.expose
Agent.define
AgentRuntime
```

WebMCP should also remain a direct Foldkit adapter because it maps almost perfectly onto the live browser Runtime:

```text
Browser agent
      ↓
WebMCP
      ↓
Foldkit AgentRuntime
      ↓
Message
```

Routing that through Agent Native would add indirection without solving a problem.

## Why not make `foldkit-agent` just an Agent Native wrapper?

Agent Native is intentionally action-first: an Action is the canonical application capability. Foldkit already has a stronger native abstraction for interactive applications: the state machine itself.

Making Agent Native foundational would risk turning this:

```text
Model + Message + update
```

into:

```text
Model + Message + update
         plus
Agent Native Actions + handlers
```

That recreates the duplicate action layer this proposal is trying to avoid.

The intended relationship is therefore:

> **Foldkit defines the agent capability contract. Agent Native may optionally host or transport that contract.**

This gives Foldkit the benefits of Agent Native's existing ecosystem without giving up the TEA-native property that humans and agents operate the same state machine.

A sensible implementation order would be:

1. keep `foldkit-agent` tiny and independent;
2. implement WebMCP directly as the first adapter;
3. prototype `foldkit-agent-native` for remote MCP/A2A/auth/CLI infrastructure;
4. only build native replacements where Agent Native is too tightly coupled to its own application architecture.

# In-app agents

An in-app chat agent can bind directly to the active Runtime:

```text
LLM
 │
 ├── projected context
 ├── exposed Messages
 │
 ▼
agent adapter
 │
 ▼
Foldkit Runtime.dispatch
```

The same `AppAgent` used by WebMCP and MCP can therefore power an
application-native chat or command surface. In-app, dispatch is checked and the
invocation can be omitted:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id })
```

# DevTools MCP vs `foldkit-agent`

These solve different problems.

## `@foldkit/devtools-mcp`

Purpose:

> Let a coding agent inspect and manipulate a running application while developing it.

Broad debugging capabilities may include:

- current and historical Models;
- Message history;
- diffs;
- keyframes;
- replay;
- the full configured Message Schema;
- arbitrary Schema-valid Message dispatch.

## `foldkit-agent`

Purpose:

> Define the stable, intentional capabilities the application itself offers to agents.

It exposes only:

- deliberately projected context;
- deliberately selected Messages;
- optional read-only resources;
- availability rules;
- authorization;
- optional completion semantics;
- protocol adapters.

```text
DevTools MCP
  = broad debugging access to a running Runtime

foldkit-agent
  = narrow application-defined capability access
```

Production agent support should never require exposing DevTools.

# Security model

The design follows four rules.

## 1. Exposure is opt-in

Do not expose the entire Message union by default.

```ts
Agent.expose(Message, {
  RequestedCreateTodo: { ... },
  RequestedDeleteTodo: { ... },
})
```

is an explicit capability boundary.

## 2. Context is projected

Do not serialize the entire Model automatically.

`Agent.context({ schema, select })` is an information boundary.

## 3. Availability is not authorization

`available(model)` decides whether a capability should currently be discoverable.

`authorize(...)` decides whether a particular caller may invoke it.

Do not conflate the two.

## 4. Domain authorization remains authoritative

Agent authorization supplements, but does not replace, backend/application authorization.

For WebMCP, browser/origin permissions and protocol controls such as `exposedTo` are additional transport-level restrictions. They complement the agent contract rather than replacing it.

# Testing

The contract should be testable without an LLM.

Both tests below are in the suite, verbatim:

```ts
test("only intended Messages are exposed", () => {
  expect(
    Agent.messages(AppAgent).map(message => message.name),
  ).toEqual([
    "create_todo",
    "rename_todo",
    "delete_todo",
  ])
})
```

Schema derivation can be tested directly:

```ts
test("delete_todo derives its input Schema", () => {
  const schema = Agent.schema(AppAgent)

  expect(
    schema.messages.find(
      message => message.name === "delete_todo",
    )?.inputSchema,
  ).toMatchObject({
    type: "object",
    required: ["id"],
  })
})
```

Agent-originated transitions need no special state-machine semantics. They are ordinary Foldkit Messages and can use the existing Story/Scene testing model.

A contract can also be exercised end to end without a browser: bind it to a host
that records what it dispatches, and assert on that.

# Design principles

### Foldkit remains the architecture

Avoid:

```text
Model + Message + update
         AND
Agent Actions + handlers
```

Prefer:

```text
Model + Message + update
          │
          └── projected to agents
```

### Adapters interpret the contract

The core should not care whether an exposed Message becomes:

- a WebMCP tool;
- an MCP tool;
- an Effect AI tool;
- an OpenAI/Anthropic function;
- an A2A capability;
- an in-app action.

### Schema is the runtime boundary

TypeScript types alone are insufficient for untrusted agent input. Agent-facing input should cross an Effect Schema boundary before dispatch.

### No DOM automation

If a capability is meaningful enough to expose, it should exist as a semantic Message rather than requiring the agent to reverse-engineer rendered markup.

### No duplicated business logic

Adapters dispatch Messages. They do not reimplement application behavior.

# Non-goals

`foldkit-agent` is not intended to:

- replace `update`;
- replace Commands;
- turn every Message into an agent tool;
- expose DevTools in production;
- make UI gesture Messages automatically agent-friendly;
- replace backend authorization;
- provide an LLM provider abstraction in core;
- require MCP or WebMCP;
- couple Foldkit core to an experimental browser API;
- infer arbitrary capabilities from rendered DOM;
- create a second `Action` architecture beside Foldkit.

# v1

The core is small:

```ts
Agent.context(...)   // or Agent.pick(...)
Agent.expose(...)
Agent.define(...)
Agent.bind(...)
```

Shipped since, in the order the plan set out: automatic docs generation
(`Agent.toMarkdown`, `Agent.toManifest`), async completion tracking, MCP over
stdio and Streamable HTTP, an audit log, and A2A.

Deferred still:

- Model replay. The audit log records what was invoked and refused, which is
  accountability, not a Model history to replay.

Shipped rather than deferred, because they cost little: custom input mapping
(`input` + `toMessage`) and named resources.

The smallest useful production adapter is WebMCP:

```text
read exposed Message descriptors
        ↓
derive JSON Schema
        ↓
document.modelContext.registerTool(...)
        ↓
validate + Runtime.dispatch(...)
```

External MCP can follow from the same contract.

# The v1 API, end to end

```ts
const TodoAgent = Agent.forModel<Model>()

const AppAgent = TodoAgent.define({
  context: Agent.pick(Model, ["selectedTodoId"]),

  messages: TodoAgent.expose(Message, {
    RequestedCreateTodo: "Create a todo",

    RequestedDeleteTodo: {
      name: "delete_todo",
      description: "Delete a todo",

      available: model =>
        Option.isSome(model.selectedTodoId),
    },
  }),
})

const agentRuntime = TodoAgent.bind({
  definition: AppAgent,
  host: { model: currentModel, dispatch: sendToRuntime },
})
```

Browser adapter:

```ts
AgentWebMcp.register({ agent: agentRuntime })
```

In-app, against the same contract:

```ts
agentRuntime.messages.dispatch(Message.RequestedDeleteTodo, { id })
```

That is the entire idea:

> **Model describes what an agent can see. The exposed Message union describes what an agent can do. `update` remains the single source of truth.**

# Open questions

## Should `Agent.context` be required?

No. It is optional, and `Agent.contextSchema` returns `undefined` when a
definition declares none. A capability may contain every identifier it needs in
its input.

## Should descriptions live on the Message union itself?

Probably not initially. Agent descriptions are interface metadata. Keeping them in `Agent.expose` leaves the application Message vocabulary protocol-neutral.

## One tool per Message or one `dispatch` tool?

One tool per exposed variant, which is what the WebMCP adapter registers:

```text
create_todo
rename_todo
delete_todo
```

Internally they are still projections of the same restricted Message union. Adapters could optionally support a single-union-tool mode when tool-count pressure matters.

## What happens to `Agent.context` in WebMCP?

That should remain adapter policy. The current WebMCP producer API is tool-oriented, so context can remain internal to availability/authorization/mapping, while explicitly queryable state can be projected as read-only tools where appropriate.

## Should completion ship in v1?

It did not. Validated dispatch is a useful and well-defined boundary. The
`completion` contract is accepted and surfaced through introspection, but
nothing executes it yet. Completion tracking becomes important when external
agents need synchronous outcomes from Command-driven workflows.

# Summary

Foldkit already has the primitives agent-first applications need:

```text
Model    = state
Message  = interaction vocabulary
update   = transition semantics
Command  = effects
Schema   = runtime contract
```

The missing primitive is a deliberate projection:

```text
Model ─────────► Agent.context
Message union ─► Agent.expose
```

From there:

```text
                     AppAgent
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
      WebMCP            MCP          in-app / A2A
```

WebMCP is particularly compelling because it can expose these capabilities directly from the page that already owns the Foldkit Runtime — no DOM automation and no external browser-session bridge required.

## Repository

```text
packages/agent          foldkit-agent
packages/agent-webmcp   foldkit-agent-webmcp
packages/agent-mcp      foldkit-agent-mcp
packages/agent-a2a      foldkit-agent-a2a
packages/agent-native   foldkit-agent-native (prototype, unpublished)
examples/todo           a worked example, end to end
```

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc -b
pnpm build       # tsdown
pnpm demo        # run examples/todo
pnpm release     # build, then publish every public package
```

Publish with **pnpm**, not npm. The adapters declare `foldkit-agent` as a
`workspace:^` peer dependency, which pnpm rewrites to a real range
(`^0.1.0`) when it packs. `npm publish` would ship the `workspace:` protocol
verbatim, and every install of that version would fail.

[`examples/todo`](./examples/todo) is the shortest path to seeing this work: one
state machine driven by a human and by an agent, exposed through WebMCP, with
the host seam written out.

**Build the state machine once. Let humans and agents speak the same Message language.**

## References

Foldkit:

- https://foldkit.dev/
- https://foldkit.dev/ai/overview
- https://foldkit.dev/ai/mcp
- https://github.com/foldkit/foldkit

WebMCP:

- https://developer.chrome.com/docs/ai/agents
- https://developer.chrome.com/docs/ai/webmcp/imperative-api
- https://github.com/webmachinelearning/webmcp

Agent Native:

- https://github.com/BuilderIO/agent-native