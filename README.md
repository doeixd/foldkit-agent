# `@foldkit/agent`

> **Proposal** — a thin, Schema-first agent layer for Foldkit.
>
> Turn a Foldkit application's **Model** and **Message union** into a deliberate agent interface, then project that interface to MCP, in-app agents, A2A, or other tool protocols without reimplementing application behavior.

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
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
                  MCP        in-app agent     A2A
```

## Status

This README describes a **proposed API**, not an API that currently ships with Foldkit.

The proposal is intentionally built on Foldkit's existing architecture rather than introducing a second application-action system.

As of Foldkit `v0.158.2`, Foldkit already has most of the underlying machinery:

- the application Model is defined with Effect `Schema`;
- application interactions are represented as a Schema-backed `Message` union;
- `view` emits Messages instead of running arbitrary event callbacks;
- `update` is the authoritative state transition function;
- Commands describe effects outside `update`;
- the Runtime already knows how to validate and dispatch Messages;
- `@foldkit/devtools-mcp` can expose the live Model, Message history, Message JSON Schema, replay, and Schema-validated Message dispatch to an AI agent during development.

The goal of `@foldkit/agent` is to take the useful architectural property behind the DevTools MCP and make it a **safe, intentional production primitive**.

---

## Why

Most applications accidentally implement the same capability multiple times.

A normal UI might have:

```text
button
  ↓
event handler
  ↓
API request
  ↓
business logic
```

Then an agent integration adds:

```text
LLM tool
  ↓
tool handler
  ↓
API request
  ↓
business logic
```

Then MCP adds another tool definition, another JSON Schema, another handler, another authorization boundary, and another place where behavior can drift.

Foldkit already removes much of this duplication because interactions are represented as values.

```ts
h.OnClick(
  Message.RequestedDeleteTodo({ id })
)
```

The UI does not own the behavior. It emits a typed Message.

The proposal is simple:

> If a semantic interaction already exists in the Foldkit Message union, exposing it to an agent should require metadata, not another implementation.

The same Message can originate from either surface:

```text
Human UI ─────────────┐
                      ▼
           RequestedDeleteTodo
                      ▲
Agent / MCP ──────────┘
                      │
                      ▼
                    update
                      │
                      ▼
                   Command
```

The agent does not click buttons, inspect the DOM, or call a parallel action API. It participates in the same application state machine as the human interface.

---

## The core idea

Foldkit already gives an application five useful pieces:

| Foldkit primitive | Agent interpretation |
| --- | --- |
| `Model` | What is true now / what context is available |
| `Message` | What can happen |
| `update` | What a Message means |
| `Command` | What effectful work follows |
| `Schema` | Machine-readable runtime contract |

`@foldkit/agent` adds two projections:

```text
Model
  │
  └── Agent.context(...) ─────► what the agent may see

Message union
  │
  └── Agent.expose(...) ──────► what the agent may do
```

Everything after that is an adapter.

```text
Agent definition
    │
    ├── MCP adapter
    ├── in-app LLM adapter
    ├── Effect AI adapter
    ├── A2A adapter
    └── future protocols
```

The core package does **not** define "MCP tools" as the application's source of truth.

The source of truth remains Foldkit.

---

# Installation

Proposed packages:

```bash
pnpm add @foldkit/agent
```

For MCP:

```bash
pnpm add @foldkit/agent @foldkit/agent-mcp
```

`foldkit` and `effect` remain peer dependencies.

---

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
  selectedTodoId: Schema.OptionFromSelf(Schema.String),
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

type Message = typeof Message.Type
```

Define the agent-visible Model projection:

```ts
import { Agent } from "@foldkit/agent"

const AgentContext = Schema.Struct({
  selectedTodoId: Schema.OptionFromSelf(Schema.String),
  todos: Schema.Array(Todo),
})

const context = Agent.context({
  schema: AgentContext,

  select: (model: Model) => ({
    selectedTodoId: model.selectedTodoId,
    todos: model.todos,
  }),
})
```

Then expose a subset of the **existing Message union**:

```ts
const messages = Agent.expose(Message, {
  RequestedCreateTodo: {
    description: "Create a new todo",
  },

  RequestedRenameTodo: {
    description: "Rename an existing todo",
  },

  RequestedDeleteTodo: {
    description: "Delete a todo",
  },
})
```

Combine them:

```ts
const AppAgent = Agent.define({
  context,
  messages,
})
```

And attach the definition to the Foldkit Runtime:

```ts
Runtime.makeApplication({
  // existing Foldkit application configuration...

  agent: AppAgent,
})
```

The Runtime now has enough information to provide an adapter with:

1. the current agent-visible context;
2. the exposed Message variants;
3. the Effect Schemas for their payloads;
4. a validated dispatch path into the real Foldkit Runtime.

An MCP adapter can compile that into tools automatically.

---

# What gets generated

Given:

```ts
Agent.expose(Message, {
  RequestedCreateTodo: {
    description: "Create a new todo",
  },

  RequestedDeleteTodo: {
    description: "Delete a todo",
  },
})
```

the MCP adapter can derive approximately:

```text
requested_create_todo
  description: Create a new todo
  input:
    title: string

requested_delete_todo
  description: Delete a todo
  input:
    id: string
```

Calling:

```json
{
  "name": "requested_delete_todo",
  "arguments": {
    "id": "todo_123"
  }
}
```

is equivalent to dispatching:

```ts
Message.RequestedDeleteTodo({
  id: "todo_123",
})
```

The Message is decoded against the real Effect Schema before it reaches `update`.

There is no separately maintained tool input type.

---

# Why expose the union?

The Message union is already Foldkit's closed vocabulary of application events.

It should remain the source of truth.

A less Foldkit-native API would define tools one at a time:

```ts
Agent.tool({
  name: "delete_todo",
  input: ...,
  execute: ...,
})
```

That creates a second behavior layer.

Instead:

```ts
Agent.expose(Message, {
  RequestedDeleteTodo: {
    description: "Delete a todo",
  },
})
```

means:

> This variant of the application's existing Message union is safe and meaningful for an agent to originate.

`Agent.expose` therefore creates a **restricted projection of the Message union**, not a new action system.

Conceptually:

```text
Message
  ├── RequestedCreateTodo   ─┐
  ├── RequestedRenameTodo   ─┼──► exposed agent Message union
  ├── RequestedDeleteTodo   ─┘
  ├── ReceivedTodos
  └── FailedToLoadTodos
```

Only the selected variants are agent-invokable.

The rest remain ordinary internal application Messages.

---

# Features

## 1. Message-union exposure

Expose selected variants of a Foldkit `Message` union.

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

Variant names are type checked against the real Message union.

Payload Schemas are derived automatically.

No duplicated tool schemas.

No duplicated executors.

---

## 2. Model projection

Do not send the entire Model to an LLM.

Define exactly what agent surfaces may observe:

```ts
const context = Agent.context({
  schema: AgentContext,

  select: model => ({
    route: model.route,
    selectedTodoId: model.selectedTodoId,
  }),
})
```

This keeps transient UI state, secrets, caches, internal handles, and large data structures out of agent context.

---

## 3. Automatic Schema derivation

Foldkit Messages already have Effect Schemas.

An adapter can derive the protocol schema mechanically:

```text
Effect Schema
    ↓
Message variant payload
    ↓
JSON Schema
    ↓
MCP inputSchema
```

The runtime validates input again before dispatch.

---

## 4. One implementation for human and agent interaction

A human can cause:

```ts
Message.RequestedDeleteTodo({ id })
```

through the view.

An agent can cause the same Message through MCP.

Both flow through the same:

```text
Message
  ↓
update
  ↓
Model + Commands
```

There is no agent-only business logic path.

---

## 5. Explicit capability boundary

Not every Message should be agent-callable.

This is unsafe:

```text
Entire Message union
        ↓
     expose all
```

This is the intended model:

```text
Entire Message union
        ↓
 explicit projection
        ↓
 agent-safe union
```

Exposure is opt-in.

---

## 6. Protocol adapters

The core definition is protocol-independent.

```text
AppAgent
  ├── @foldkit/agent-mcp
  ├── @foldkit/agent-effect-ai
  ├── @foldkit/agent-a2a
  └── in-app agent runtime
```

MCP should be a projection of the agent contract, not the contract itself.

---

## 7. Optional resources

Some state is useful on demand but should not live in every prompt.

```ts
const TodosResource = Agent.resource("todos", {
  description: "The user's current todo list",
  schema: Schema.Array(Todo),
  read: model => model.todos,
})
```

An adapter may expose this as an MCP resource such as:

```text
app://todos
```

This keeps `context` small while still making richer state inspectable.

---

## 8. Authorization hooks

A Message being exposed does not imply every caller may invoke it.

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",

  authorize: ({ principal, input, model }) =>
    principal.can("todo:delete", input.id),
}
```

Authorization runs before dispatch.

The application's existing domain authorization still remains authoritative.

---

## 9. Async completion semantics

Dispatching a Message and completing an operation are not always the same event.

For request/Command/result flows:

```text
RequestedDeleteTodo
        ↓
      update
        ↓
   DeleteTodo Command
        ↓
 DeletedTodo / FailedDeleteTodo
```

an exposed capability may optionally specify completion Messages:

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

The adapter may then wait for the correlated result before resolving the tool call.

Without `completion`, successful validated dispatch is the completion boundary.

---

## 10. Introspection

Because the public interface is data, adapters can provide:

```ts
Agent.schema(AppAgent)
Agent.messages(AppAgent)
Agent.contextSchema(AppAgent)
```

This makes the generated contract testable without starting an LLM.

---

# Designing Messages for agents

The most important convention is semantic, not technical.

Avoid treating physical UI gestures as your public agent vocabulary.

For example:

```ts
ClickedDeleteButton
```

describes **how a human caused an event**.

An agent did not click a button.

Prefer a surface-independent Message when the event represents a domain interaction:

```ts
RequestedDeleteTodo
```

Then the view can dispatch it:

```ts
h.OnClick(
  Message.RequestedDeleteTodo({ id })
)
```

and an agent can dispatch the same variant.

```text
button ──────────────┐
                     ▼
          RequestedDeleteTodo
                     ▲
agent ───────────────┘
```

UI-specific Messages are still valid Foldkit Messages. They simply should not normally be part of the exposed agent union.

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

The distinction is not "user Message" versus "system Message."

The question is:

> Does this Message represent a coherent capability that another interaction surface could legitimately originate?

---

# API reference

## `Agent.define`

Creates an application agent definition.

```ts
const AppAgent = Agent.define({
  context,
  messages,
  resources,
})
```

### Signature

```ts
Agent.define<
  Model,
  Message,
  Context,
  Resources
>(options: {
  context?: Agent.Context<Model, Context>
  messages: Agent.ExposedMessages<Message>
  resources?: ReadonlyArray<Agent.Resource<Model, unknown>>
}): Agent.Definition<Model, Message, Context, Resources>
```

### Options

#### `context`

Optional agent-visible projection of the current Foldkit Model.

Created with `Agent.context`.

#### `messages`

Required exposed projection of the application's Message union.

Created with `Agent.expose`.

#### `resources`

Optional read-only Model projections that adapters may expose on demand.

Created with `Agent.resource`.

### Notes

`Agent.define` contains no LLM provider configuration and no MCP-specific configuration.

It describes the application's agent contract only.

---

## `Agent.context`

Defines the safe Model projection available to agents.

```ts
const context = Agent.context({
  schema: AgentContext,

  select: model => ({
    route: model.route,
    selectedTodoId: model.selectedTodoId,
  }),
})
```

### Signature

```ts
Agent.context<Model, Context>(options: {
  schema: Schema.Schema<Context>
  select: (model: Model) => Context
}): Agent.Context<Model, Context>
```

### `schema`

Effect Schema describing the projected context.

The schema serves several purposes:

- runtime validation;
- JSON Schema derivation;
- documentation;
- adapter interoperability;
- avoiding a compile-time-only TypeScript boundary.

### `select`

Pure projection from the current Foldkit Model.

```ts
(model: Model) => Context
```

`select` should not perform effects.

If data is not already represented by the Model, obtain it through normal Foldkit effect boundaries rather than reading the outside world here.

### Example

```ts
const AgentContext = Schema.Struct({
  route: Route,
  selectedId: Schema.OptionFromSelf(Schema.String),
})

const context = Agent.context({
  schema: AgentContext,

  select: model => ({
    route: model.route,
    selectedId: model.selectedId,
  }),
})
```

---

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

### Signature

Conceptually:

```ts
Agent.expose<MessageUnion, Tags>(
  Message: MessageUnion,
  variants: {
    [Tag in SelectedTags]: Agent.VariantConfig<
      MessageUnion,
      Tag
    >
  }
): Agent.ExposedMessages<
  MessageUnion,
  SelectedTags
>
```

The exact implementation types would depend on the metadata exposed by `defineMessageUnion`.

### Behavior

For each selected variant, `Agent.expose` derives:

- the Message tag;
- the Message constructor;
- the payload Effect Schema;
- a protocol-safe default capability name;
- decoding logic;
- dispatch logic.

### Safety

Only variants present in the configuration object are exposed.

There is deliberately no default "expose every Message" mode.

### Why an object instead of `include: string[]`

This:

```ts
Agent.expose(Message, {
  RequestedCreateTodo: {
    description: "Create a todo",
  },
})
```

is preferred to:

```ts
Agent.expose(Message, {
  include: ["RequestedCreateTodo"],
})
```

because the keyed form:

- mirrors Foldkit's union-oriented APIs;
- keeps configuration beside the selected variant;
- catches invalid variant names;
- avoids parallel `include`, `descriptions`, `names`, and permission maps.

---

# `Agent.VariantConfig`

Configuration for one exposed Message variant.

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete a todo",
  authorize,
  completion,
}
```

### Shape

```ts
interface VariantConfig<Input, Model, Principal> {
  /**
   * External capability name.
   * Defaults to a normalized form of the Message tag.
   */
  readonly name?: string

  /**
   * Human/LLM-readable description.
   */
  readonly description: string

  /**
   * Optional authorization check before dispatch.
   */
  readonly authorize?: (
    request: Agent.AuthorizationRequest<
      Input,
      Model,
      Principal
    >
  ) =>
    | boolean
    | Effect.Effect<boolean, Agent.AuthorizationError, unknown>

  /**
   * Optional async completion contract.
   */
  readonly completion?: Agent.Completion<unknown, unknown>
}
```

---

## `name`

Overrides the adapter-facing capability name.

```ts
RequestedDeleteTodo: {
  name: "delete_todo",
  description: "Delete a todo",
}
```

Without a name, adapters normalize the Message tag:

```text
RequestedDeleteTodo
        ↓
requested_delete_todo
```

Adapters may impose stricter protocol naming requirements.

The Message tag itself never changes.

---

## `description`

Required natural-language explanation of the capability.

```ts
RequestedRenameTodo: {
  description: "Rename an existing todo",
}
```

Descriptions should explain semantic behavior, not UI mechanics.

Prefer:

```text
Delete a todo
```

over:

```text
Act like the user pressed the red Delete button
```

---

## `authorize`

Optional pre-dispatch authorization.

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",

  authorize: ({ principal, input }) =>
    principal.canDeleteTodo(input.id),
}
```

### Request

```ts
interface AuthorizationRequest<Input, Model, Principal> {
  readonly principal: Principal
  readonly input: Input
  readonly model: Model
  readonly transport: Agent.Transport
}
```

### Semantics

1. adapter decodes external input;
2. Foldkit resolves the current Runtime and Model;
3. `authorize` runs;
4. denied calls never dispatch a Message;
5. allowed calls dispatch through the same Runtime path as any other Message.

Authorization here protects the agent interface.

It does **not** replace authorization inside Commands, backend services, databases, or APIs.

---

# `Agent.Completion`

Optional description of when a dispatched capability has actually completed.

```ts
completion: {
  success: Message.DeletedTodo,
  failure: Message.FailedDeleteTodo,

  correlate: (request, result) =>
    request.id === result.id,
}
```

### Shape

```ts
interface Completion<Request, Result> {
  readonly success:
    | MessageConstructor<Result>
    | ReadonlyArray<MessageConstructor<Result>>

  readonly failure?:
    | MessageConstructor<unknown>
    | ReadonlyArray<MessageConstructor<unknown>>

  readonly correlate?: (
    request: Request,
    result: Result
  ) => boolean

  readonly timeout?: Duration.DurationInput
}
```

### Default semantics

Without a completion contract:

```text
valid input
   ↓
Message decoded
   ↓
Message dispatched
   ↓
tool resolves
```

This matches the simple semantics of Foldkit's current development Message dispatch capability.

### Completion semantics

With a completion contract:

```text
tool call
   ↓
Message dispatched
   ↓
Runtime observes later Messages
   ↓
correlated success/failure
   ↓
tool resolves
```

### Correlation

Correlation matters when multiple operations are in flight.

Unsafe:

```text
delete A ─┐
delete B ─┼─► first DeletedTodo completes whichever call is waiting
          ┘
```

Safe:

```ts
correlate: (request, result) =>
  request.id === result.id
```

For operations without a naturally unique field, applications should include a request/correlation ID in the relevant Messages.

---

# `Agent.resource`

Defines optional read-only state that can be requested separately from the default agent context.

```ts
const TodosResource = Agent.resource("todos", {
  description: "The user's current todos",
  schema: Schema.Array(Todo),
  read: model => model.todos,
})
```

### Signature

```ts
Agent.resource<Model, Value>(
  name: string,
  options: {
    description: string
    schema: Schema.Schema<Value>
    read: (model: Model) => Value
  }
): Agent.Resource<Model, Value>
```

### Use cases

Use a resource when:

- the data is too large for the default context;
- the data is useful only for some tasks;
- the data maps naturally to an MCP resource;
- the agent should explicitly request it.

### MCP projection

An MCP adapter may expose:

```text
Agent.resource("todos", ...)
```

as:

```text
app://todos
```

The exact URI namespace belongs to the adapter.

---

# `Agent.schema`

Returns a protocol-neutral description of the generated agent contract.

```ts
const schema = Agent.schema(AppAgent)
```

### Signature

```ts
Agent.schema(
  definition: Agent.Definition<any, any, any, any>
): Agent.Schema
```

### Example result

```ts
{
  messages: [
    {
      tag: "RequestedCreateTodo",
      name: "requested_create_todo",
      description: "Create a todo",
      inputSchema: { /* JSON Schema */ },
    },
  ],

  context: {
    schema: { /* JSON Schema */ },
  },

  resources: [
    {
      name: "todos",
      description: "The user's current todos",
      schema: { /* JSON Schema */ },
    },
  ],
}
```

This API is useful for tests, documentation generation, protocol adapters, and debugging.

---

# `Agent.messages`

Returns metadata for the exposed Message projection.

```ts
const capabilities = Agent.messages(AppAgent)
```

### Signature

```ts
Agent.messages(
  definition: Agent.Definition<any, any, any, any>
): ReadonlyArray<Agent.MessageDescriptor>
```

This function does not expose non-agent Message variants.

---

# `Agent.contextSchema`

Returns the JSON-Schema-compatible description of the agent context.

```ts
const schema = Agent.contextSchema(AppAgent)
```

### Signature

```ts
Agent.contextSchema(
  definition: Agent.Definition<any, any, any, any>
): JsonSchema.JsonSchema | undefined
```

---

# Advanced input mapping

Direct union exposure should cover the common case.

Sometimes the internal Message payload should not be the public agent input.

Example:

```ts
const Message = defineMessageUnion({
  RequestedDeleteTodo: {
    id: Schema.String,
    source: Source,
    requestId: Schema.String,
  },
})
```

The UI may populate all three fields, while an external agent should only provide `id`.

The advanced form can override the external input Schema and map it into the real Message:

```ts
Agent.expose(Message, {
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
  },
})
```

### Extended `VariantConfig`

```ts
interface VariantConfig<
  MessageInput,
  ExternalInput = MessageInput,
  Model = unknown,
  Principal = unknown
> {
  readonly name?: string
  readonly description: string

  readonly input?: Schema.Schema<ExternalInput>

  readonly toMessage?: (
    input: ExternalInput,
    context: Agent.InvocationContext<Model, Principal>
  ) => MessageInput

  readonly authorize?: ...
  readonly completion?: ...
}

interface InvocationContext<Model, Principal> {
  readonly model: Model
  readonly principal: Principal
  readonly invocation: Agent.Invocation
}

interface Invocation {
  readonly id: string
  readonly transport: Agent.Transport
}
```

### Rule

If `input` is provided, `toMessage` is required.

If neither is provided, the Message variant payload is the external input and the real Message constructor is used directly.

The common path therefore remains:

```ts
RequestedDeleteTodo: {
  description: "Delete a todo",
}
```

not a second tool definition.

---

# Runtime integration

The proposed Foldkit integration is intentionally small:

```ts
Runtime.makeApplication({
  // Model / init / update / view / existing configuration

  agent: AppAgent,
})
```

The Runtime owns:

- the current Model;
- Message dispatch;
- Message validation;
- Message history;
- Command execution.

Therefore the Runtime is the natural place to bind an abstract `Agent.Definition` to a live application.

Conceptually:

```text
Agent.Definition
      +
Foldkit Runtime
      ↓
bound agent runtime
      │
      ├── readContext()
      ├── readResource(name)
      ├── listCapabilities()
      └── dispatch(capability, input)
```

Adapters depend on this bound interface rather than reaching into `update` directly.

---

# Proposed bound runtime contract

This does not necessarily need to be public in v1, but it defines the seam protocol adapters require.

```ts
interface AgentRuntime {
  readonly definition: Agent.Definition<any, any, any, any>

  readonly context: Effect.Effect<unknown>

  readonly resources: {
    readonly read: (
      name: string
    ) => Effect.Effect<unknown, Agent.ResourceError>
  }

  readonly messages: {
    readonly list: Effect.Effect<
      ReadonlyArray<Agent.MessageDescriptor>
    >

    readonly dispatch: (
      name: string,
      input: unknown,
      invocation: Agent.Invocation
    ) => Effect.Effect<
      Agent.DispatchResult,
      Agent.DispatchError
    >
  }
}
```

This seam is what makes the core architecture adapter-independent.

---

# MCP adapter

Proposed package:

```text
@foldkit/agent-mcp
```

The adapter projects a bound `AgentRuntime` into MCP.

Conceptually:

```ts
import { AgentMcp } from "@foldkit/agent-mcp"

const server = AgentMcp.make({
  application: App,
})
```

or through server/platform configuration:

```ts
AgentMcp.serve({
  application: App,
  path: "/mcp",
})
```

The final shape should follow whichever server conventions Foldkit adopts; the important point is that **no Message/tool definitions are repeated in the MCP package**.

---

## MCP tool generation

Each exposed Message variant becomes one MCP tool by default.

```text
RequestedCreateTodo
        ↓
requested_create_todo

RequestedRenameTodo
        ↓
requested_rename_todo
```

For:

```ts
RequestedRenameTodo: {
  id: Schema.String,
  title: Schema.String,
}
```

the generated tool is approximately:

```json
{
  "name": "requested_rename_todo",
  "description": "Rename an existing todo",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      }
    },
    "required": ["id", "title"]
  }
}
```

The actual Message remains:

```ts
Message.RequestedRenameTodo({
  id,
  title,
})
```

---

## MCP context

The default agent context can be available through a conventional MCP resource:

```text
app://context
```

or injected into an in-app agent automatically.

This is an adapter policy, not part of the application's state model.

---

## MCP resources

```ts
Agent.resource("todos", ...)
```

can become:

```text
app://todos
```

The resource Schema and description are derived from the agent definition.

---

# In-app agents

An in-app agent does not need an external network bridge.

It can bind directly to the active Foldkit Runtime:

```text
LLM
 │
 ├── current context
 ├── exposed Messages
 │
 ▼
agent adapter
 │
 ▼
Foldkit Runtime.dispatch
```

The same `AppAgent` definition used by MCP can therefore back a chat panel inside the application.

---

# External MCP and browser Runtime state

There is an important architectural difference between an in-app agent and a public MCP endpoint.

A Foldkit Model commonly lives in a browser Runtime.

An external MCP client lives outside that browser.

Therefore production MCP needs an authenticated transport that binds the external caller to the correct application Runtime/session.

Foldkit's current DevTools MCP already demonstrates the basic topology in development:

```text
MCP process
    ↕
Vite relay
    ↕
browser bridge
    ↕
Foldkit Runtime
```

A production implementation should **not** simply enable the DevTools relay.

Instead, `@foldkit/agent-mcp` should provide or integrate with a production-safe transport with:

- authentication;
- Runtime/session identity;
- authorization;
- origin policy;
- explicit exposed capabilities only;
- no replay/debugging surface unless separately enabled;
- rate limits / cancellation;
- disconnect handling.

The agent contract and the transport are intentionally separate.

---

# DevTools MCP vs `@foldkit/agent`

These solve different problems.

## `@foldkit/devtools-mcp`

Purpose:

> Let a coding agent inspect and manipulate a running application while developing it.

It can expose broad runtime introspection such as:

- current and historical Models;
- Message history;
- diffs;
- keyframes;
- replay;
- the full configured Message Schema;
- arbitrary Schema-valid Message dispatch.

It is development tooling.

## `@foldkit/agent`

Purpose:

> Define the stable, intentional capabilities the application itself offers to agents.

It exposes:

- a deliberately projected Model context;
- a deliberately selected subset of Messages;
- optional read-only resources;
- authorization;
- completion semantics;
- production protocol adapters.

It should never require exposing DevTools.

---

# Security model

Agent access should follow three rules.

## 1. Exposure is opt-in

There should be no production equivalent of:

```ts
Agent.exposeAll(Message)
```

The application author explicitly selects every agent-originatable Message.

---

## 2. Context is projected

Do not serialize the entire Model by default.

```ts
Agent.context({
  schema,
  select,
})
```

is an information boundary.

---

## 3. Domain authorization remains authoritative

Even an authorized MCP invocation may trigger a Command that calls a backend.

The backend should continue enforcing its own authorization.

Agent authorization is an additional capability boundary, not a replacement for application security.

---

# Naming and semantics

## Message tags remain application vocabulary

Do not rename your internal Message tags merely for MCP.

```ts
RequestedDeleteTodo
```

remains the application Message.

The adapter may expose:

```text
delete_todo
```

through:

```ts
{
  name: "delete_todo"
}
```

---

## Prefer facts and semantic requests

Foldkit Messages should continue following Foldkit's fact-oriented style.

Agent-safe Messages should additionally be surface-independent where possible.

For example:

```text
RequestedDeleteTodo
SubmittedSearch
SelectedProject
RequestedExport
```

work across UI, voice, MCP, automation, and other surfaces.

---

# Full example

```ts
import { Effect, Schema } from "effect"
import { Agent } from "@foldkit/agent"
import { Command, Runtime, Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

// MODEL

const Todo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
})

type Todo = typeof Todo.Type

const Model = Schema.Struct({
  todos: Schema.Array(Todo),
  selectedTodoId: Schema.OptionFromSelf(Schema.String),
})

type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
  RequestedCreateTodo: {
    title: Schema.String,
  },

  RequestedDeleteTodo: {
    id: Schema.String,
  },

  CreatedTodo: {
    todo: Todo,
  },

  DeletedTodo: {
    id: Schema.String,
  },

  FailedDeleteTodo: {
    id: Schema.String,
    error: Schema.String,
  },

  ChangedSearchInput: {
    value: Schema.String,
  },
})

type Message = typeof Message.Type

// COMMAND

const CreateTodo = Command.define("CreateTodo", {
  args: {
    title: Schema.String,
  },

  messages: [
    Message.CreatedTodo,
  ],

  execute: ({ title }) =>
    Effect.sync(() =>
      Message.CreatedTodo({
        todo: {
          id: crypto.randomUUID(),
          title,
          completed: false,
        },
      }),
    ),
})

const DeleteTodo = Command.define("DeleteTodo", {
  args: {
    id: Schema.String,
  },

  messages: [
    Message.DeletedTodo,
    Message.FailedDeleteTodo,
  ],

  execute: ({ id }) =>
    Effect.gen(function* () {
      // delete through an Effect service

      return Message.DeletedTodo({ id })
    }),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const update = (
  model: Model,
  message: Message,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    RequestedCreateTodo: ({ title }) => ({
      model,
      commands: [
        CreateTodo({ title }),
      ],
    }),

    CreatedTodo: ({ todo }) => ({
      model: {
        ...model,
        todos: [
          ...model.todos,
          todo,
        ],
      },
    }),

    RequestedDeleteTodo: ({ id }) => ({
      model,
      commands: [
        DeleteTodo({ id }),
      ],
    }),

    DeletedTodo: ({ id }) => ({
      model: {
        ...model,
        todos: model.todos.filter(todo => todo.id !== id),
      },
    }),

    FailedDeleteTodo: () => ({
      model,
    }),

    ChangedSearchInput: () => ({
      model,
    }),
  })

// AGENT CONTEXT

const AgentContext = Schema.Struct({
  selectedTodoId: Schema.OptionFromSelf(Schema.String),

  todos: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      completed: Schema.Boolean,
    }),
  ),
})

const context = Agent.context({
  schema: AgentContext,

  select: (model: Model) => ({
    selectedTodoId: model.selectedTodoId,
    todos: model.todos,
  }),
})

// AGENT MESSAGE PROJECTION

const messages = Agent.expose(Message, {
  RequestedCreateTodo: {
    name: "create_todo",
    description: "Create a new todo",
  },

  RequestedDeleteTodo: {
    name: "delete_todo",
    description: "Delete a todo",

    completion: {
      success: Message.DeletedTodo,
      failure: Message.FailedDeleteTodo,

      correlate: (request, result) =>
        request.id === result.id,
    },
  },
})

// OPTIONAL RESOURCE

const TodosResource = Agent.resource("todos", {
  description: "The user's complete todo list",
  schema: Schema.Array(Todo),
  read: (model: Model) => model.todos,
})

// AGENT DEFINITION

const AppAgent = Agent.define({
  context,
  messages,
  resources: [
    TodosResource,
  ],
})

// APPLICATION

const Application = Runtime.makeApplication({
  // existing Foldkit application configuration...
  agent: AppAgent,
})
```

The agent-facing contract is derived from the same application architecture:

```text
Context
  selectedTodoId
  todos

Tools
  create_todo(title)
  delete_todo(id)

Resources
  app://todos
```

There is no second `createTodo()` or `deleteTodo()` implementation for the agent.

---

# Testing

The agent contract should be testable without an LLM.

## Contract test

```ts
test("only intended Messages are exposed", () => {
  expect(
    Agent.messages(AppAgent).map(message => message.name),
  ).toEqual([
    "create_todo",
    "delete_todo",
  ])
})
```

## Schema test

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

## State-machine test

Agent-originated Messages need no special update tests.

They are ordinary Foldkit Messages and can be exercised with the existing Story test tools:

```ts
story(
  update,
  given(model),
  message(
    Message.RequestedDeleteTodo({
      id: "todo_123",
    }),
  ),
  Command.expectExact(DeleteTodo),
)
```

This is one of the main benefits of the design.

The agent path reuses the state machine that is already tested.

---

# Design principles

## Foldkit stays the architecture

`@foldkit/agent` must not become a parallel framework inside Foldkit.

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

---

## Adapters interpret the contract

The core package should not care whether an exposed Message becomes:

- an MCP tool;
- an Effect AI tool;
- an OpenAI/Anthropic function;
- an A2A capability;
- an in-app chat action.

The application defines capabilities once.

---

## Schema is the boundary

TypeScript types alone are insufficient because agent input arrives at runtime.

All agent-facing data should ultimately cross an Effect Schema boundary.

---

## No DOM automation

The agent should not need to understand rendered markup in order to operate the application.

If a capability is meaningful enough to expose, it should exist as a semantic Message.

---

## No duplicated business logic

An agent adapter dispatches Messages.

It does not contain application behavior.

---

# Non-goals

`@foldkit/agent` is not intended to:

- replace `update`;
- replace Commands;
- turn every Message into an agent tool;
- expose DevTools in production;
- make UI gesture Messages automatically agent-friendly;
- replace backend authorization;
- provide an LLM provider abstraction in core;
- require MCP;
- infer arbitrary capabilities from rendered DOM;
- create a second "Action" architecture beside Foldkit.

---

# Relationship to action-first frameworks

Some agent-first frameworks make an `Action` the universal primitive and project it into UI, HTTP, MCP, CLI, and agents.

Foldkit does not need to adopt that architecture wholesale.

Foldkit already has a stronger application-level structure:

```text
Model
  ↓
Message
  ↓
update
  ↓
Model + Commands
```

The proposed agent layer treats **application transitions** as universal rather than introducing universal action handlers.

That means Foldkit retains:

- one Model;
- one Message vocabulary;
- one update function;
- explicit effects;
- replayable state transitions;
- existing Story/Scene testing;
- existing DevTools observability.

The agent interface is a projection of this architecture.

---

# Relationship to the existing DevTools MCP

The current DevTools MCP is evidence that the underlying idea works.

It already demonstrates:

```text
Effect Message Schema
        ↓
JSON Schema
        ↓
agent constructs Message
        ↓
Schema decode
        ↓
Runtime dispatch
```

`@foldkit/agent` would make three key changes for production use:

1. **subset instead of full Message union**;
2. **projected context instead of unrestricted Model inspection**;
3. **production authorization/transport semantics instead of a development relay**.

In other words:

```text
DevTools MCP
  = broad debugging access to a running Foldkit Runtime

@foldkit/agent
  = narrow application-defined capability access to a Foldkit Runtime
```

---

# Minimal v1

The smallest useful implementation only needs three core APIs:

```ts
Agent.context(...)
Agent.expose(...)
Agent.define(...)
```

and Runtime integration:

```ts
Runtime.makeApplication({
  agent: AppAgent,
})
```

An initial MCP adapter only needs:

```text
tools/list
tools/call
resources/read(app://context)
```

Everything else can follow.

A realistic v1 therefore excludes:

- async completion tracking;
- custom input mapping;
- named resources;
- A2A;
- transport-specific permissions;
- automatic documentation;
- history/replay.

Those are extensions of the same contract rather than prerequisites.

---

# Proposed v1 API

If the package needs to remain extremely small, this is the API to ship first:

```ts
const AgentContext = Schema.Struct({
  selectedTodoId: Schema.OptionFromSelf(Schema.String),
})

const AppAgent = Agent.define({
  context: Agent.context({
    schema: AgentContext,

    select: model => ({
      selectedTodoId: model.selectedTodoId,
    }),
  }),

  messages: Agent.expose(Message, {
    RequestedCreateTodo: {
      description: "Create a todo",
    },

    RequestedDeleteTodo: {
      description: "Delete a todo",
    },
  }),
})

Runtime.makeApplication({
  // ...
  agent: AppAgent,
})
```

Everything important is visible in that example.

> **Model describes what an agent can see. The exposed Message union describes what an agent can do. `update` remains the single source of truth.**

---

# Open questions

## Should `Agent.context` be required?

Probably not.

An application may expose capabilities whose required identifiers are always explicit in tool input.

---

## Should Message descriptions live on the Message union itself?

Probably not initially.

Agent descriptions are interface metadata. Keeping them in `Agent.expose` allows the same Message union to remain free of agent-specific concerns.

If Foldkit later gains general Message annotations useful to DevTools, docs, accessibility, and agents, sharing metadata could make sense.

---

## Should MCP expose one tool per Message or one `dispatch` tool?

For production, one tool per exposed variant is likely the better default.

```text
create_todo
delete_todo
rename_todo
```

is easier for LLMs to understand than:

```text
dispatch({
  _tag: ...
})
```

Internally, however, both are projections of the same restricted Message union.

An adapter could optionally support a single-union-tool mode for hosts where tool-count pressure matters.

---

## Should Model context be a resource or automatically inserted?

That should be adapter policy.

The application only defines the safe projection.

An in-app agent may inject it automatically, while MCP may expose `app://context`.

---

## Should completion be part of v1?

Probably not.

Validated dispatch is already a useful and well-defined semantic boundary.

Completion tracking becomes valuable once real external agents need synchronous outcomes from Command-driven workflows.

---

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
        ┌───────────┼───────────┐
        ▼           ▼           ▼
       MCP      in-app AI      A2A
```

No duplicate action layer.

No agent-only business logic.

No DOM simulation.

No handwritten MCP schema for behavior the application has already modeled.

**Build the state machine once. Let humans and agents speak the same Message language.**

---

## References

This proposal is based on the current Foldkit architecture and DevTools MCP behavior documented for Foldkit `v0.158.2`:

- Foldkit: https://foldkit.dev/
- AI architecture: https://foldkit.dev/ai/overview
- DevTools MCP: https://foldkit.dev/ai/mcp
- Repository: https://github.com/foldkit/foldkit
