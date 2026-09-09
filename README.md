# `@foldkit/agent`

> **Proposal** — a thin, Schema-first agent layer for Foldkit.
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

This README describes a **proposed API**, not an API that currently ships with Foldkit.

The proposal is intentionally built on Foldkit's existing architecture rather than introducing a second application-action system.

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

---

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
@foldkit/agent-webmcp
      ↓
current Foldkit Runtime
      ↓
Message → update → Commands
```

The agent is attached to the same page and the same state machine as the human. There is no separate server bridge required merely to identify what application state the user means.

That makes WebMCP a strong candidate for the **first production adapter** for this proposal.

---

# The model

Foldkit already gives us the important pieces:

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

---

# Installation

Proposed packages:

```bash
pnpm add @foldkit/agent
```

Browser-native WebMCP:

```bash
pnpm add @foldkit/agent @foldkit/agent-webmcp
```

External MCP:

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
```

Project the Model state that agents may observe:

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

Expose a subset of the **existing Message union**:

```ts
const messages = Agent.expose(Message, {
  RequestedCreateTodo: {
    name: "create_todo",
    description: "Create a new todo",
  },

  RequestedRenameTodo: {
    name: "rename_todo",
    description: "Rename an existing todo",
  },

  RequestedDeleteTodo: {
    name: "delete_todo",
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

Attach the definition to the Foldkit Runtime:

```ts
const Application = Runtime.makeApplication({
  // existing Foldkit application configuration...
  agent: AppAgent,
})
```

From that one definition, protocol adapters can derive their tool surfaces automatically.

---

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

A WebMCP adapter can mechanically produce something equivalent to:

```ts
await document.modelContext.registerTool({
  name: "delete_todo",
  description: "Delete a todo",
  inputSchema: /* derived JSON Schema */,

  execute: async ({ id }, { signal }) =>
    agentRuntime.messages.dispatch(
      "delete_todo",
      { id },
      {
        id: crypto.randomUUID(),
        transport: "webmcp",
        signal,
      },
    ),
})
```

An external MCP adapter can expose the same contract through `tools/list` and `tools/call`.

There is no separately maintained tool input type or executor.

---

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

---

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

---

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

Conceptual signature:

```ts
Agent.define<Model, Message, Context, Resources>(options: {
  context?: Agent.Context<Model, Context>
  messages: Agent.ExposedMessages<Message>
  resources?: ReadonlyArray<Agent.Resource<Model, unknown>>
}): Agent.Definition<Model, Message, Context, Resources>
```

`Agent.define` contains no model-provider or MCP/WebMCP configuration. It describes the application's agent contract only.

---

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

Conceptual signature:

```ts
Agent.context<Model, Context>(options: {
  schema: Schema.Schema<Context>
  select: (model: Model) => Context
}): Agent.Context<Model, Context>
```

### `schema`

Effect Schema for the projected context. It provides runtime validation, documentation, and JSON Schema derivation.

### `select`

Pure projection from the current Foldkit Model. It should not perform effects.

Do not expose the entire Model by default. The projection is an information boundary.

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

Conceptually:

```ts
Agent.expose<MessageUnion, SelectedTags>(
  Message: MessageUnion,
  variants: {
    [Tag in SelectedTags]: Agent.VariantConfig<
      MessageUnion,
      Tag
    >
  }
): Agent.ExposedMessages<MessageUnion, SelectedTags>
```

For every selected variant, Foldkit can derive:

- Message tag;
- constructor;
- payload Effect Schema;
- JSON Schema;
- default external name;
- decoding logic;
- dispatch logic.

There should be no production `exposeAll()` default. Exposure is a capability boundary.

---

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

Conceptual shape:

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

Without an override, adapters may normalize the Message tag.

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

Conceptual signature:

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

A WebMCP adapter can use registration `AbortSignal`s to unregister capabilities that are no longer available and register them again when state changes.

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

Conceptual request:

```ts
interface AuthorizationRequest<Input, Model, Principal> {
  readonly principal: Principal
  readonly input: Input
  readonly model: Model
  readonly transport: Agent.Transport
}
```

Denied calls never dispatch a Message.

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

Conceptually:

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
    result: Result,
  ) => boolean

  readonly timeout?: Duration.DurationInput
}
```

Without a completion contract, successful validated dispatch is the completion boundary.

---

## `Agent.resource`

Defines read-only Model state that can be requested separately from the default context.

```ts
const TodosResource = Agent.resource("todos", {
  description: "The user's current todos",
  schema: Schema.Array(Todo),
  read: model => model.todos,
})
```

Conceptual signature:

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

---

## Introspection

Because the agent contract is data, it should be inspectable and testable without an LLM.

```ts
Agent.schema(AppAgent)
Agent.messages(AppAgent)
Agent.contextSchema(AppAgent)
```

Conceptual signatures:

```ts
Agent.schema(
  definition: Agent.Definition<any, any, any, any>,
): Agent.Schema

Agent.messages(
  definition: Agent.Definition<any, any, any, any>,
): ReadonlyArray<Agent.MessageDescriptor>

Agent.contextSchema(
  definition: Agent.Definition<any, any, any, any>,
): JsonSchema.JsonSchema | undefined
```

Adapters can depend on this protocol-neutral description rather than inspecting application internals.

---

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

The optional `signal` gives adapters a common cancellation primitive.

For WebMCP this maps naturally from the cancellation signal passed to a tool's `execute` function.

---

# Runtime integration

The Foldkit Runtime already owns the pieces an agent adapter needs:

- current Model;
- Message validation;
- Message dispatch;
- Message history;
- Command execution.

So the natural integration point is:

```ts
Runtime.makeApplication({
  // existing configuration
  agent: AppAgent,
})
```

Conceptually this binds an abstract `Agent.Definition` to a live runtime:

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

A possible internal seam:

```ts
interface AgentRuntime {
  readonly definition: Agent.Definition<any, any, any, any>

  readonly context: Effect.Effect<unknown>

  readonly resources: {
    readonly read: (
      name: string,
    ) => Effect.Effect<unknown, Agent.ResourceError>
  }

  readonly messages: {
    readonly list: Effect.Effect<
      ReadonlyArray<Agent.MessageDescriptor>
    >

    readonly dispatch: (
      name: string,
      input: unknown,
      invocation: Agent.Invocation,
    ) => Effect.Effect<
      Agent.DispatchResult,
      Agent.DispatchError
    >
  }
}
```

Protocol adapters bind to this seam rather than reaching into `update` directly.

---

# WebMCP adapter

Proposed package:

```text
@foldkit/agent-webmcp
```

Minimal usage:

```ts
import { AgentWebMcp } from "@foldkit/agent-webmcp"

const registration = AgentWebMcp.register({
  application: Application,
})
```

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
@foldkit/agent
  = stable application capability model

@foldkit/agent-webmcp
  = current browser protocol interpretation
```

That lets the browser API change without forcing the Foldkit agent contract to change with it.

---

# External MCP adapter

Proposed package:

```text
@foldkit/agent-mcp
```

Conceptually:

```ts
import { AgentMcp } from "@foldkit/agent-mcp"

const server = AgentMcp.make({
  application: Application,
})
```

or:

```ts
AgentMcp.serve({
  application: Application,
  path: "/mcp",
})
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

Production external MCP therefore needs a transport/session layer that can bind the caller to the correct Runtime.

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

---

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

The same `AppAgent` used by WebMCP and MCP can therefore power an application-native chat or command surface.

---

# DevTools MCP vs `@foldkit/agent`

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

## `@foldkit/agent`

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

@foldkit/agent
  = narrow application-defined capability access
```

Production agent support should never require exposing DevTools.

---

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

---

# Testing

The contract should be testable without an LLM.

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

---

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
- require MCP or WebMCP;
- couple Foldkit core to an experimental browser API;
- infer arbitrary capabilities from rendered DOM;
- create a second `Action` architecture beside Foldkit.

---

# Minimal v1

The core can remain very small:

```ts
Agent.context(...)
Agent.expose(...)
Agent.define(...)
```

with Runtime integration:

```ts
Runtime.makeApplication({
  agent: AppAgent,
})
```

A realistic v1 can defer:

- async completion tracking;
- custom input mapping;
- named resources;
- A2A;
- automatic docs generation;
- history/replay.

The smallest useful production adapter is likely WebMCP:

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

---

# Proposed v1 API

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
      name: "create_todo",
      description: "Create a todo",
    },

    RequestedDeleteTodo: {
      name: "delete_todo",
      description: "Delete a todo",

      available: model =>
        Option.isSome(model.selectedTodoId),
    },
  }),
})

const Application = Runtime.makeApplication({
  // ...
  agent: AppAgent,
})
```

Browser adapter:

```ts
AgentWebMcp.register({
  application: Application,
})
```

That is the entire idea:

> **Model describes what an agent can see. The exposed Message union describes what an agent can do. `update` remains the single source of truth.**

---

# Open questions

## Should `Agent.context` be required?

Probably not. A capability may contain every identifier it needs in its input.

## Should descriptions live on the Message union itself?

Probably not initially. Agent descriptions are interface metadata. Keeping them in `Agent.expose` leaves the application Message vocabulary protocol-neutral.

## One tool per Message or one `dispatch` tool?

For production WebMCP/MCP, one tool per exposed variant is probably the better default:

```text
create_todo
rename_todo
delete_todo
```

Internally they are still projections of the same restricted Message union. Adapters could optionally support a single-union-tool mode when tool-count pressure matters.

## What happens to `Agent.context` in WebMCP?

That should remain adapter policy. The current WebMCP producer API is tool-oriented, so context can remain internal to availability/authorization/mapping, while explicitly queryable state can be projected as read-only tools where appropriate.

## Should completion ship in v1?

Probably not. Validated dispatch is already a useful and well-defined boundary. Completion tracking becomes important when external agents need synchronous outcomes from Command-driven workflows.

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
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
      WebMCP            MCP          in-app / A2A
```

WebMCP is particularly compelling because it can expose these capabilities directly from the page that already owns the Foldkit Runtime — no DOM automation and no external browser-session bridge required.

**Build the state machine once. Let humans and agents speak the same Message language.**

---

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
