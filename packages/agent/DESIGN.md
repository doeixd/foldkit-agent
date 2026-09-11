# `foldkit-agent`

> Design rationale for `foldkit-agent` and its integration with the wider
> project, including the proposed `foldkit-surface` package. For the API
> summary see the [package README](./README.md); for the umbrella project see
> the [root README](../../README.md).

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

The agent API sections describe the existing implementation. The
[surface proposal](#project-cohesion-proposed-foldkit-surface) describes the next
integration layer; it is not a shipped API.

| Package | What it is |
| --- | --- |
| [`foldkit-agent`](./README.md) | The protocol-neutral contract: `context`, `expose`, `define`, `resource`, introspection, and the bound `AgentRuntime`. |
| [`foldkit-agent-webmcp`](../agent-webmcp) | The browser adapter, projecting exposed Messages into `document.modelContext`. |
| [`foldkit-agent-mcp`](../agent-mcp) | The external MCP adapter: a transport-free protocol handler, plus stdio and HTTP. |
| [`foldkit-agent-a2a`](../agent-a2a) | The A2A adapter: an Agent Card and `message/send` as tasks. |
| [`foldkit-durable`](../durable) | A durable, ordered operation log with snapshots, compaction, change streams, and a durable effect ledger. |
| [`foldkit-sync`](../sync) | A local-first replica with an offline outbox, optimistic projection, presence, and a reconnecting transport. |
| [`foldkit-agent-native`](../agent-native) | A private prototype adapting the contract to Agent Native, with integration tests against the real framework. |
| `foldkit-surface` (proposed) | A common contract and Foldkit binding for interacting with a running application; no implementation yet. |

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

The surface proposal makes that application-supplied integration reusable across
agent access and replication, while preserving each package's independent use.

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

Offline, multiplayer, or remote-agent state:

```bash
pnpm add foldkit-durable foldkit-sync
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

`available` defines whether the capability **currently belongs to the
application's agent capability set**. Live tool discovery omits it while it is
false, and the Runtime rejects invocation with
`AgentCapabilityUnavailableError` even from a caller who already knows the name.
Availability is stronger than tool visibility.

The A2A Agent Card and Agent Native prototype registry describe the static
contract, including conditional capabilities. Their invocation paths still
enforce live availability.

It is not authorization. Calls may still require `authorize`, and
backend/domain authorization remains authoritative.

Do not reach for `available` to mirror incidental UI state. A predicate like
`model.route._tag === 'Settings'` also makes the capability impossible to invoke
whenever the user is looking at another screen, which is rarely what the route
was expressing. Use it where the state genuinely changes whether the capability
exists -- a delete with nothing selected has nothing to delete.

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

`model` is the invocation's Model snapshot: the same value `available` was
checked against, not a fresh read.

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
dispatch the Message. A refusal before host dispatch sends no Message. A host
failure may occur after delivery; completion timeouts and cancellation after
delivery do not undo it.
Decoding rejects undeclared fields, matching the `additionalProperties: false`
that the derived JSON Schema advertises.

Failures are `Schema`-backed, so `Effect.catchTag` narrows them and an adapter
can encode one to JSON and send it on: `AgentUnknownCapabilityError`,
`AgentCapabilityUnavailableError`, `AgentInvalidInputError`,
`AgentAuthorizationError`, and `AgentResourceError`. Every `message` is written
for the calling agent and never restates application internals.

An invocation captures one Model snapshot when dispatch begins. `available`,
`authorize` and `toMessage` all observe that snapshot -- `host.model()` is read
once per invocation, and `InvocationContext.model` is that value -- so a Model
change while decoding or authorization is pending does not retarget an
invocation already in flight. That is snapshot consistency, not live-state
freshness: the next invocation sees the newer Model. Nothing rejects a dispatch
because the live Model has advanced; see the
[package README](./README.md#the-model-snapshot).

The host must replace Models rather than mutate them in place: the runtime
retains the returned reference, without cloning it. Unknown capabilities and
already-cancelled invocations are refused before reading the Model.

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
`unregister()`. See the [package README](../agent-webmcp) for the
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
Refuse before dispatch, or stop waiting for completion
```

The signal does not cancel or roll back work already handed to the host.

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

The repository contains a private `foldkit-agent-native` prototype, tested
against `@agent-native/core@0.177.1`'s registry, tool runtime, and schema wrapper.
Full deployment integration remains unverified, so it is not part of the
published set:

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

`available(model)` decides whether a capability currently exists at all --
unavailable means neither advertised nor invocable.

`authorize(...)` decides whether a particular caller may invoke one that does.

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

Shipped rather than deferred, because they cost little: custom input mapping
(`input` + `toMessage`) and named resources. What the plan did defer has since
landed as well -- automatic docs generation (`Agent.toMarkdown`,
`Agent.toManifest`), async completion tracking, MCP over stdio and Streamable
HTTP, an audit log, and A2A.

Still deferred: Model replay. The audit log records what was invoked and what
was refused, which is accountability, not a Model history to replay.

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

# Project cohesion: proposed `foldkit-surface`

The next project-wide improvement is a reusable way to attach packages to a
running Foldkit application. `foldkit-surface` should provide that integration
contract and a supported Foldkit binding. Foldkit's Model, Message, `update`, and
Commands remain the application's architecture.

This is an architectural direction, not a finalized API. Establish the runtime
guarantees and prove the bindings before choosing public constructors or moving
existing exports.

## The integration gap

The packages already share application behavior, but applications still assemble
their runtime connections by hand:

- `Agent.bind` requires Model access, dispatch, subscriptions, and Message
  observation for completion tracking.
- [`examples/sync/src/runtime.ts`](../../examples/sync/src/runtime.ts) wraps
  Foldkit to persist durable Messages before displaying their optimistic result,
  then installs reconciled shared state while preserving local fields.
- [`examples/sync/src/serverAgent.ts`](../../examples/sync/src/serverAgent.ts)
  binds agents to a journal-backed Model and dispatch path under a trusted
  principal.
- [`examples/sync/src/journal.ts`](../../examples/sync/src/journal.ts) adapts the
  durable journal to the replica protocol and server effect policy.

Surface should remove the repeated runtime wiring. Journal protocol mapping and
effect policy still belong to the integrations that understand them. Moving all
four files into a common package would obscure that distinction.

One concrete failure the design must prevent: a port accepts `CreatedTodo`, an
agent reports success, and IndexedDB later refuses the write. Port acceptance
does not acknowledge persistence. A common handle is useful only if its caller
can tell which boundary it has actually reached.

## Definition and running instance

Keep an application definition separate from its running instances. A definition
identifies the Model and Message schemas and the existing transition function;
it can be inspected and used in tests without mounting a browser or opening
storage. Reuse the existing application configuration where possible rather
than making authors declare the same schemas and `update` twice.

A bound surface addresses one instance: a mounted browser application, a local
replica, or an authoritative server document. It provides state access, Message
submission, and observation with explicit lifecycle semantics. The same
application can have several instances; there is no global current runtime.

Each binding must state the Model it actually owns. A server with only shared
state cannot satisfy a contract that reads browser selection. Neither a cast nor
an invented default local Model makes those capabilities meaningful server-side.

## Package responsibilities and dependency direction

| Package | Responsibility with surface |
| --- | --- |
| `foldkit-surface` | The live application contract, Foldkit binding, readiness, submission and observation semantics, and binding lifecycle. |
| `foldkit-agent` | Agent-visible context, explicit capability exposure, input mapping, availability, authorization, completion matching, and audit. Bind these to a compatible surface. |
| Protocol adapters | Continue consuming `AgentRuntime`; interpret agent results for MCP, WebMCP, A2A, or Agent Native. |
| `foldkit-sync` | Outbox persistence, optimistic state, authoritative reconciliation, checkpoints, presence, and replica transport. Its Foldkit integration supplies a compatible surface. |
| `foldkit-durable` | Atomic journal operations, snapshots, compaction, identities, and effect records. Remains usable independently of surface and Foldkit. |
| Application | Shared-state selection, durable Message classification, domain authorization, effect authority, and deployment policy. |

Surface core must not import the agent adapters, IndexedDB, or SQLite. Keep
browser mounting separate from the contract so a server can consume the contract
without loading DOM code. Agent and sync integrations may depend on surface;
surface must not depend back on them. A package dependency does not require an
application to enable the associated feature.

Retain the existing structural `AgentHost`, storage, and transport extension
points during migration. Custom hosts and adapters remain valid ways to compose
the packages. Surface should supply a well-defined default integration rather
than require every consumer to adopt a new application builder.

## Independent projections

The application may share schemas and selectors, but these declarations carry
different policies:

| Declaration | Question it answers |
| --- | --- |
| Live Model | What state does this application instance own? |
| Agent context and resources | What state may an agent observe? |
| Exposed Messages | What may an agent request? |
| Shared state | What state must replicas agree on? |
| Durable Messages | What operations may be persisted and replayed? |

An agent may select a local item without creating a durable operation. An
internal result Message may be replicated without being agent-invocable. Shared
state may contain fields excluded from agent context. Do not infer exposure from
durability, or treat the shared projection as the agent information boundary.

The raw surface is a trusted application integration handle. External callers
still enter through an adapter's validation and agent capability boundary.
Transport identity comes from authentication, never from a caller-supplied
Message field or a replay marker. The authoritative journal's domain policy
remains the final decision on a replicated write.

## Submission, observation, and ordering

Specify these guarantees before finalizing method names:

- **Readiness.** Binding must expose when initial state and required storage are
  ready. An early request waits or fails explicitly; it cannot observe fabricated
  state or disappear into an uninitialized port.
- **Submission.** Distinguish receipt by a queue from application of a Message.
  A successful surface submission must acknowledge the binding's documented
  application boundary. The replica binding persists the outbox before publishing
  its optimistic transition. A failed save publishes no successful transition.
- **Authority.** Local persistence does not imply server acceptance. Sync owns
  the acknowledgement or rejection of the stable operation identity and the
  resulting rebase. A generic surface must not manufacture that guarantee for a
  local-only application.
- **Business completion.** Applying a Message does not imply completion of its
  Commands. Agent retains its explicit success/failure Message matching. Do not
  hold the admission queue while waiting for business completion: the completing
  Message may need to enter that same queue.
- **Observation.** Define when a processed Message is observable relative to the
  installed Model. Listeners must see the corresponding state, and completion
  listeners must attach before submission can produce their event. Historical
  replay and checkpoint installation must not masquerade as newly completed work.
- **Reconciliation.** Apply validated shared state to the latest local Model,
  preserving local fields. A checkpoint is state installation, not a newly
  submitted Message; it cannot enqueue another outbound operation or rerun
  external work. Keep this privileged operation in the sync binding.
- **Concurrency.** Serialize conflicting state changes and reconcile against
  the state current at application time. Network exchange must leave room for
  offline edits. Specify which local transitions may proceed while persistence
  is pending; do not accidentally freeze selection behind a network request.
- **Lifecycle.** Declare who owns the instance, storage scope, and subscriptions.
  Detaching one adapter must not dispose a shared application. Disposal refuses
  new submissions and settles pending callers; cancellation after persistence
  or delivery cannot promise rollback. Define reentrant listener behavior and
  isolate observer failures from committed work.

A create operation can therefore be locally persisted and visible, later
accepted by the authority, and later completed by an external service. These
are separate facts. The public result types must let integrations distinguish
the facts they need without requiring all applications to implement every stage.

Preserve the agent runtime's existing snapshot semantics: availability,
authorization, and input mapping use one Model snapshot for an invocation.
Admission can happen later against newer application state. Surface does not
silently reinterpret the target or turn that snapshot into a concurrency lock;
version checks, when required, must be explicit and enforced at the authoritative
transition boundary.

## Replay and Command authority

The current sync example permits only state-only durable transitions. Its replay
helper rejects Commands and changes to local fields, while server effects are
declared separately. Surface must preserve that supported subset until a broader
execution policy is designed and tested.

Deriving replay from `update` and a field list cannot prove it correct. A
transition can read local selection to choose a shared entity without changing
any local field. Supplying initial local state during replay would then produce
a different result. Durable Messages must carry the inputs needed to replay
deterministically; schemas and runtime guards cannot prove arbitrary JavaScript
pure or independent of local state.

A future Command integration needs explicit execution authority, stable semantic
effect identities, and a policy for how result Messages return to shared state.
Rebase and historical replay must not rerun external effects. The durable ledger
reuses recorded successes, but cannot atomically commit an external provider's
action and its local result. Surface adds no exactly-once guarantee. Preserve
the [durable recovery requirements](../durable/README.md#effect-recovery), and
keep recovery and effect ownership outside the initial surface contract.

## Type safety and composability

The common contract must preserve the distinctions the packages already check:

- Infer Model and Message from their owning definition; reject an incompatible
  host, shared-state binding, or principal provider. A host may accept a wider
  Message union than an agent exposes, but never a narrower one.
- Distinguish encoded wire/storage values from decoded application Messages and
  Models. Validate unknown input at the boundary that consumes it; preserve
  transforming codecs without double decoding or silently stripping fields.
- Preserve each capability's input inference and constructor-based dispatch.
  Do not flatten variants into `any` or require annotations at every callback.
- Describe supported operations in types. A binding without processed-Message
  observation cannot promise agent completion tracking; a local binding cannot
  promise authoritative acknowledgement. Avoid an all-optional interface that
  pushes every incompatibility to runtime.
- Keep Effect failures, required services, and scopes visible through adapters.
  Use the installed Effect 4 APIs; execute Effects at browser/protocol edges
  instead of hiding `runSync` inside a supposedly portable service.
- Preserve branded document, producer, operation, and caller identities. An
  invocation id is not automatically a durable operation id or a retry key.

Prove rejection as well as acceptance in type tests. Public examples must compile
against real Foldkit and peer types, including transforming schemas and bindings
whose Models intentionally differ. Prefer small structural contracts to a
registration framework or an unrestricted middleware chain whose ordering each
application must rediscover.

## Incremental implementation and acceptance

1. Specify readiness, submission acknowledgement, event ordering, and ownership
   against the current examples. Keep public API spelling provisional.
2. Implement a local Foldkit binding and use it in the todo example. Preserve
   direct `Agent.bind` hosts and protocol adapter APIs.
3. Replace the handwritten sync runtime wrapper for its existing state-only
   subset. Route UI events, subscriptions, Command result Messages, and agent
   submissions through the intended admission path. Wrapping only external
   dispatch would leave UI Messages able to bypass persistence.
4. Bind a server document through the same minimal contract with its actual
   shared Model. Keep journal exchange mapping and recovery policy in their
   owning integrations. Remove example glue only after its behavior is covered.
5. Compare the application setup before and after. Publish surface when the
   examples require less wiring, custom integrations still compose, and no
   existing guarantee has been weakened. Broader Command support is separate.

Acceptance must exercise failed persistence, synchronous completion, concurrent
local edits during persistence and exchange, server rejection and rebase,
checkpoint installation without resubmission, multiple bound instances, and
disposal with pending work. Verify that all entry paths honor admission and that
observers cannot mistake history for fresh execution. Mutation-check behavioral
tests and include negative type cases, following the repository agreements.

Foldkit `0.158.2` exposes ports and disposal on its embedded handle, without a
public asynchronous admission hook or direct live Model access. Use supported
configuration and port APIs for the initial binding; do not depend on private
runtime internals or start a competing state loop beside Foldkit. If transparent
integration for arbitrary applications requires an upstream hook, document the
specific missing guarantee and propose that hook. Keep the supported subset
explicit rather than claiming a wrapper has solved it.

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

Completion tracking is implemented. When a capability declares `completion`,
dispatch waits for a matching Message, timeout, or cancellation; the host must
provide `observe`. Without a completion contract, successful host dispatch is
the completion boundary.

# Summary

Foldkit already has the primitives agent-first applications need:

```text
Model    = state
Message  = interaction vocabulary
update   = transition semantics
Command  = effects
Schema   = runtime contract
```

The agent layer adds deliberate projections:

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

The proposed surface layer makes the connection to that running application
reusable across agent access and replication. Its acceptance is concrete: less
application glue, explicit submission and lifecycle guarantees, preserved type
inference, and continued independent use of the packages.

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
